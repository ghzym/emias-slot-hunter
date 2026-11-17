const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSpeciality } = require('../core/speciality.js');
const { createUtil } = require('../core/util.js');
const { createFilters } = require('../core/filters.js');
const { createUiState } = require('../userscript/ui-state.js');

const util = createUtil();
const filters = createFilters(util);
const day = '2026-11-20';
const now = () => Date.parse('2026-11-19T22:00:00+03:00');
const clinic = { id: 10, title: 'Тестовый филиал', address: 'г. Москва, улица Тестовая, дом 4, корпус 1' };
const otherAddress = 'Москва, ул. Тестовая, д. 4, к. 2';
const address = 'ул. Тестовая, д. 4, к. 1';
const group = { code: '2028', group: 'dermatology', title: 'Дерматовенеролог',
  members: [{ code: '2028', title: 'Дерматология', clinicSelection: true }] };
const purpose = { id: 61, code: 251, title: 'Приём', allowed: [], lpuTypeIds: [1] };
const source = { account: 'profile-test', codes: ['2028'], purpose, dermatology: true, clinic };
const startTime = day + 'T10:00:00';
const endTime = day + 'T10:15:00';
const slot = { startTime, endTime };
const target = { id: 'one', scenario: 'bookSpeciality', source, onlyDay: day, minLeadMs: 0, respectTravel: false };
const ctx = { now: now(), appointments: [] };
const record = { id: 777, startTime, lpuAddress: address, toDoctor: { specialityId: 2028 } };
const endpoints = {
  policy: 'v2/policy',
  purposes: 'v7/inquiryPurpose/getInquiryPurpose',
  clinics: 'v4/saOrchestrator/getLpusForSpeciality',
  doctors: 'v5/saOrchestrator/getDoctorsInfo',
  schedule: 'v4/saOrchestrator/getAvailableResourceScheduleInfo',
  check: 'v6/chatBot/check',
  book: 'v4/saOrchestrator/createAppointment',
  records: 'v10/saOrchestrator/getAppointmentReceptionsByPatient',
};
const ok = (payload) => ({ ok: true, status: 200, json: { payload } });
const room = (id, defaultAddress) => ({ id, room: { defaultAddress, lpuShortName: 'Тестовый филиал' } });
const doctor = (id, complexResource) => ({
  id, lpuId: 10, arSpecialityId: 2028, complexResource,
  mainDoctor: { lastName: 'Врач' }, receptionType: [{ primary: 1, home: 0, code: 3 }],
});
const candidate = {
  clinic, code: 2028, lpuId: 10, address: clinic.address, slot, resourceId: 20, roomId: 30, receptionTypeId: 3,
};

function fixture(handlers, profileKey = async () => source.account) {
  const calls = [];
  const call = async (path, body, once) => {
    calls.push({ path, body, once });
    assert.ok(Object.hasOwn(handlers, path), 'Неожиданный запрос ' + path);
    return typeof handlers[path] === 'function' ? handlers[path](body) : handlers[path];
  };
  const api = { post: call, getForPatient: call, backoffUntil: () => 0 };
  return { service: createSpeciality({ api, util, filters, now, profileKey }), calls };
}

test('берёт цели визита и отделения дерматологии из ЕМИАС до появления свободных слотов', async () => {
  const { service, calls } = fixture({
    [endpoints.policy]: ok({ patient: { attachments: [{ lpu: { lpuType: { id: 1 } } }] } }),
    [endpoints.purposes]: ok([
      { title: 'Приём', inquiryPurposeId: 61, inquiryPurposeCode: 251, lpuTypeId: [1] },
      { title: 'Видео', inquiryPurposeId: 62, inquiryPurposeCode: 252, receptionForm: { code: 'telemedicine' } },
    ]),
    [endpoints.clinics]: ok({ lpu: [{ id: 10, shortName: clinic.title, address: [{ addressString: clinic.address }] }] }),
  });
  const { account, choices } = await service.purposes(group);
  assert.deepEqual(choices, [purpose]);
  assert.equal(account, source.account);
  assert.deepEqual(calls[1].body, { specialityCode: '2028', lpuTypeId: '1', isMainPage: false, isReferral: false });
  const departments = await service.departments(group, choices[0], account, group.code);
  assert.deepEqual(departments.clinics, [clinic]);
  assert.deepEqual(calls[2].body, { specialityCode: group.code });
});

test('проверяет только выбранный корпус и день, игнорируя соседний корпус и чужие даты', async () => {
  const { service, calls } = fixture({
    [endpoints.doctors]: ok({ doctorsInfo: [
      { lpuId: 10, availableResources: [
        doctor(20, [room(30, address), room(31, otherAddress)]),
        { ...doctor(21, [room(32, address)]), availableByReferral: true },
      ] },
      { lpuId: 11, availableResources: [doctor(22, [room(33, address)])] },
    ] }),
    [endpoints.schedule]: ok({
      availableResource: { complexResource: [room(30, address)] },
      scheduleOfDay: [{ scheduleBySlot: [
        { complexResourceId: '30', slot: [slot, { ...slot, startTime: '2026-11-21T10:00:00' }] },
        { complexResourceId: 31, slot: [{ ...slot, startTime: day + 'T09:55:00' }] },
      ] }],
    }),
  });
  const result = await service.search(target, ctx);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].slot, slot);
  assert.deepEqual(calls.map((c) => c.path), [endpoints.doctors, endpoints.schedule]);
  assert.deepEqual(calls[0].body, { specialityId: ['2028'], inquiryPurposeId: 61, purposeReceptionForm: 'personal', lpuId: 10 });
  assert.deepEqual(calls[1].body.period, { dateFrom: day, dateTo: day });
  assert.equal(calls[1].body.complexResourceId, 30);
});

test('отправляет запись на найденный слот и проверяет подтверждение в списке ЕМИАС', async () => {
  const { service, calls } = fixture({
    [endpoints.check]: ok({ inquiryPurposeBlock: false }),
    [endpoints.book]: ok({ appointmentId: record.id }),
    [endpoints.records]: ok({ appointment: [record] }),
  });
  const result = await service.book(target, candidate, ctx);
  assert.equal(result.verified, true);
  assert.equal(result.newAppointment.id, record.id);
  assert.deepEqual(calls.map((c) => c.path), [endpoints.check, endpoints.book, endpoints.records]);
  assert.deepEqual(calls[1].body, { availableResourceId: 20, complexResourceId: 30, startTime, endTime,
    inquiryPurposeId: 61, inquiryPurposeCode: 251, receptionTypeId: 3 });
  assert.equal(calls[1].once, true);
});

test('не отправляет запись при обязательном опросе, смене полиса или остановке до отправки', async () => {
  const survey = fixture({ [endpoints.check]: ok({ inquiryPurposeBlock: true, complaint: { hash: 'fixture' } }) });
  const result = await survey.service.book(target, candidate, ctx);
  assert.equal(result.action, 'stopTarget');
  assert.match(result.message, /опрос/);
  assert.deepEqual(survey.calls.map((c) => c.path), [endpoints.check]);

  const changed = fixture({}, async () => 'other-policy');
  assert.equal((await changed.service.book(target, candidate, ctx)).action, 'stopTarget');
  assert.deepEqual(changed.calls, []);

  let running = true;
  const cancelled = fixture({ [endpoints.check]: () => { running = false; return ok({}); } });
  assert.equal((await cancelled.service.book(target, candidate, { ...ctx, active: () => running })).ok, false);
  assert.deepEqual(cancelled.calls.map((c) => c.path), [endpoints.check]);
});

test('не записывает повторно и останавливается при неопределённом результате', async () => {
  const { service, calls } = fixture({
    [endpoints.check]: ok({}),
    [endpoints.book]: { ok: false, status: 0 },
    [endpoints.records]: ok({ appointment: [{ ...record, lpuAddress: otherAddress }] }),
  });
  assert.equal((await service.book(target, candidate, { ...ctx, appointments: [record] })).action, 'stopTarget');
  assert.deepEqual(calls, []);
  const unknown = await service.book(target, candidate, ctx);
  assert.equal(unknown.action, 'stopTarget');
  assert.equal(unknown.verified, false);
  assert.equal(calls.filter((c) => c.path === endpoints.book).length, 1);
});

test('мастер сохраняет выбранный день и полный адрес отделения', () => {
  const ui = createUiState();
  const built = ui.buildTarget({ ...target, title: 'Дерматовенеролог', address: clinic.address },
    { when: 'onlyDay', day, where: 'sameCampus', mode: 'auto' });
  assert.equal(built.onlyDay, day);
  assert.equal(built.keepImproving, false);
  assert.equal(built.mode, 'auto');
  assert.equal(built.addressContains, null);
  assert.match(ui.describeTarget(built), /корпус 1/);
});
