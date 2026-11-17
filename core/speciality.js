(function (root) {
  'use strict';

  function createSpeciality({ api, util, filters, now, profileKey }) {
    const id = (value) => {
      const n = Number(value);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    };
    const text = (value) => typeof value === 'string' ? value.trim() : '';
    const addressKey = (value) => text(value).toLowerCase()
      .replace(/^(?:г\.?\s+|город\s+)?москва[,\s]+/u, '')
      .replace(/(^|[\s,])(?:улица|ул\.?)(?=\s)/gu, '$1ул')
      .replace(/(^|[\s,])(?:дом|д\.?)(?=\s)/gu, '$1д')
      .replace(/(^|[\s,])(?:корпус|корп\.?|к\.?)(?=\s)/gu, '$1к')
      .replace(/\s*,\s*/g, ' ').replace(/\s+/g, ' ').trim();
    const sameAddress = (a, b) => !!addressKey(a) && addressKey(a) === addressKey(b);
    const items = (value) => Array.isArray(value) ? value : [];
    const doctorName = (resource) => {
      const doctor = resource.mainDoctor || {};
      return [doctor.lastName, doctor.firstName, doctor.secondName].map(text).filter(Boolean).join(' ') || text(resource.name);
    };
    const payload = (r) => r.json?.payload;
    const apptPath = 'v10/saOrchestrator/getAppointmentReceptionsByPatient';
    const fail = (message, action = 'stopTarget') => ({ ok: false, verified: false, message, action });
    const empty = (notes, action = null) => ({ candidates: [], rejected: [], notes, action });

    async function purposes(group) {
      const account = await profileKey();
      if (!account) throw new Error('Откройте раздел «Записи» для нужного полиса и повторите.');
      const patient = await api.post('v2/policy', { typeAttach: [0, 1, 2, 3], onlyMoscowPolicy: false });
      if (!patient.ok || !payload(patient)?.patient) throw new Error('ЕМИАС не загрузил прикрепление по выбранному полису.');
      const types = items(payload(patient).patient.attachments).map((a) => id(a?.lpu?.lpuType?.id)).filter(Boolean);
      if (await profileKey() !== account) throw new Error('Выбран другой полис. Начните настройку заново.');
      const response = await api.getForPatient('v7/inquiryPurpose/getInquiryPurpose', {
        isMainPage: false, isReferral: false, lpuTypeId: [...new Set(types)].join(','),
        specialityCode: group.members.map((member) => member.code).join(','),
      });
      if (!response.ok || !Array.isArray(payload(response))) throw new Error('ЕМИАС не отдал цели визита для этой специальности.');
      if (await profileKey() !== account) throw new Error('Выбран другой полис. Начните настройку заново.');

      const choices = [];
      function add(purpose, inheritedForm, prefix) {
        const title = text(purpose?.title) || text(purpose?.purposeName);
        const label = prefix && title ? prefix + ' / ' + title : title || prefix;
        const form = purpose?.receptionForm?.code || inheritedForm;
        const nested = items(purpose?.purpose);
        if (nested.length) {
          nested.forEach((child) => add(child, form, label));
          return;
        }
        const purposeId = id(purpose?.inquiryPurposeId);
        const purposeCode = id(purpose?.inquiryPurposeCode);
        if (!label || !purposeId || !purposeCode || form === 'telemedicine') return;
        const allowed = items(purpose.groupMedicalSpeciality).flatMap((g) => items(g?.specialities))
          .map((member) => id(member?.code)).filter(Boolean);
        const lpuTypeIds = items(purpose.lpuTypeId).map(id).filter(Boolean);
        choices.push({ id: purposeId, code: purposeCode, title: label, allowed, lpuTypeIds });
      }
      payload(response).forEach((p) => add(p, null, ''));
      return { account, choices };
    }

    async function doctorList(source) {
      const body = {
        specialityId: source.codes, inquiryPurposeId: source.purpose.id, purposeReceptionForm: 'personal',
      };
      if (source.clinic) body.lpuId = source.clinic.id;
      if (!source.dermatology && source.purpose.lpuTypeIds.length) body.lpuTypeId = source.purpose.lpuTypeIds;
      return api.post('v5/saOrchestrator/getDoctorsInfo', body);
    }

    function rooms(result, source) {
      const found = [];
      for (const clinic of items(payload(result)?.doctorsInfo)) {
        const clinicId = id(clinic?.lpuId);
        if (!clinicId || (source.clinic && clinicId !== source.clinic.id)) continue;
        for (const resource of items(clinic.availableResources)) {
          const code = id(resource?.arSpecialityId || resource?.mainDoctor?.specialityId);
          const resourceId = id(resource?.id);
          if (!resourceId || !source.codes.includes(String(code)) || resource.available === false ||
              resource.notAvailable || resource.availableByReferral || resource.isTmk) continue;
          for (const cr of items(resource.complexResource)) {
            const roomId = id(cr?.id);
            const address = text(cr?.room?.defaultAddress);
            if (!roomId || !address || (source.clinic && !sameAddress(address, source.clinic.address))) continue;
            const title = text(cr.room.lpuShortName) || text(clinic.lpuShortName) || 'Отделение';
            const reception = items(resource.receptionType).find((r) => String(r?.primary) === '1' && String(r?.home) === '0');
            found.push({
              clinic: { id: clinicId, title, address }, resourceId, roomId, code, name: doctorName(resource),
              lpuId: id(resource.lpuId) || clinicId, receptionTypeId: id(reception?.code),
            });
          }
        }
      }
      return found;
    }

    async function departments(group, purpose, account, selectedMember) {
      if (await profileKey() !== account) throw new Error('Выбран другой полис. Начните настройку заново.');
      const dermatology = group.group === 'dermatology';
      const eligible = group.members.filter((m) => !m.paid && !m.certificate);
      const members = dermatology ? eligible.filter((m) => m.code === selectedMember)
        : eligible.filter((m) => !purpose.allowed.length || purpose.allowed.includes(id(m.code)));
      const codes = [...new Set(members.map((m) => m.code))];
      const source = { account, codes, purpose, dermatology };
      if (!codes.length) return { source, clinics: [] };
      if (!dermatology && members.some((m) => m.multipleClinics)) {
        throw new Error('Для этой специальности ЕМИАС открывает отдельную форму записи.');
      }
      let clinics;
      if (dermatology && members[0].clinicSelection) {
        const result = await api.post('v4/saOrchestrator/getLpusForSpeciality', { specialityCode: codes[0] });
        if (!result.ok || !Array.isArray(payload(result)?.lpu)) throw new Error('ЕМИАС не отдал список филиалов.');
        clinics = payload(result).lpu.flatMap((clinic) => {
          const clinicId = id(clinic?.id);
          if (!clinicId) return [];
          return items(clinic.address).map((a) => ({
            id: clinicId, title: text(clinic.shortName) || text(clinic.name) || 'Отделение', address: text(a?.addressString),
          })).filter((a) => a.address);
        });
      } else {
        const result = await doctorList(source);
        if (!result.ok || !Array.isArray(payload(result)?.doctorsInfo)) throw new Error('ЕМИАС не отдал список отделений.');
        const listed = payload(result).doctorsInfo.map((d) => ({
          id: id(d?.lpuId), title: text(d?.lpuShortName) || 'Отделение', address: text(d?.defaultAddress),
        })).filter((d) => d.id && d.address);
        clinics = [...listed, ...rooms(result, source).map((r) => r.clinic)];
      }
      if (await profileKey() !== account) throw new Error('Выбран другой полис. Начните настройку заново.');
      const unique = new Map(clinics.map((c) => [String(c.id) + '|' + addressKey(c.address), c]));
      return { source, clinics: [...unique.values()].sort((a, b) => (a.title + a.address).localeCompare(b.title + b.address, 'ru')) };
    }

    const dayOf = (startTime) => Number.isFinite(util.toMs(startTime)) ? util.mskDate(new Date(util.toMs(startTime))) : null;
    const sameSpeciality = (s, appointment) => s.codes.includes(String(id(appointment?.toDoctor?.specialityId)));

    function selectedDays(target) {
      const dates = Array.isArray(target.days) ? target.days : [target.onlyDay];
      return [...new Set(dates.filter((day) => typeof day === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(day) && dayOf(day + 'T12:00:00') === day))].sort();
    }

    function schedulePeriods(days) {
      const periods = [];
      const maxSpanMs = 30 * 24 * 60 * 60 * 1000;
      for (const day of days) {
        const last = periods.at(-1);
        // При большом разбросе дат сохраняем 30-дневное окно обычного поиска.
        if (last && util.toMs(day + 'T00:00:00') - util.toMs(last.dateFrom + 'T00:00:00') <= maxSpanMs) {
          last.dateTo = day;
        } else {
          periods.push({ dateFrom: day, dateTo: day });
        }
      }
      return periods;
    }

    function appointmentMatches(t, a, days, c = null) {
      const clinicId = id(a?.lpuId);
      return sameSpeciality(t.source, a) && days.has(dayOf(a.startTime)) &&
        (!clinicId || clinicId === t.source.clinic.id || clinicId === c?.lpuId) &&
        sameAddress(a.lpuAddress, t.source.clinic.address) && (!c || util.toMs(a.startTime) === util.toMs(c.slot.startTime));
    }

    async function search(t, ctx) {
      const s = t.source;
      const days = selectedDays(t);
      if (!days.length || !s?.clinic?.id || !s.clinic.address || !s.codes?.length || !s.purpose?.id) {
        return empty(['Выберите специальность, отделение и дату заново.'], 'stopTarget');
      }
      const today = util.mskDate(new Date(ctx.now));
      const periods = schedulePeriods(days.filter((day) => day >= today));
      if (!periods.length) return empty(['Все выбранные даты уже прошли.'], 'stopTarget');
      if (await profileKey() !== s.account) return empty(['Выбран другой полис. Откройте «Настроить» для нужного полиса.'], 'stopTarget');
      const dateSet = new Set(days);
      if (ctx.appointments.some((a) => appointmentMatches(t, a, dateSet))) {
        return empty(['Запись в этом отделении на одну из выбранных дат уже есть.'], 'stopTarget');
      }
      const resources = await doctorList(s);
      if (!resources.ok) return empty([resources.explained?.message || 'ЕМИАС не отдал список врачей.'], resources.explained?.action);
      const candidates = [];
      const notes = [];
      let rejected = [];
      let action = null;
      const available = rooms(resources, s);
      const visited = new Set();
      const filterTarget = { ...t, onlyDay: null };
      roomLoop:
      for (const r of available) {
        const key = r.resourceId + '|' + r.roomId;
        if (visited.has(key)) continue;
        visited.add(key);
        for (const period of periods) {
          if (now() < api.backoffUntil() || ctx.active?.() === false) break roomLoop;
          const schedule = await api.post('v4/saOrchestrator/getAvailableResourceScheduleInfo', {
            availableResourceId: r.resourceId, complexResourceId: r.roomId, inquiryPurposeId: s.purpose.id, period,
          });
          if (!schedule.ok) {
            const msg = schedule.explained?.message || 'ЕМИАС не отдал расписание.';
            if (!notes.includes(msg)) notes.push(msg);
            action = schedule.explained?.action || action;
            continue;
          }
          const info = payload(schedule);
          if (id(info?.availableResource?.id) && id(info.availableResource.id) !== r.resourceId) continue;
          const room = items(info?.availableResource?.complexResource).find((c) => id(c?.id) === r.roomId);
          if (!sameAddress(room?.room?.defaultAddress, s.clinic.address)) continue;
          const slots = items(info?.scheduleOfDay).flatMap((d) => items(d?.scheduleBySlot))
            .filter((b) => b?.complexResourceId == null || id(b.complexResourceId) === r.roomId)
            .flatMap((b) => items(b?.slot)).filter((slot) => {
              const day = dayOf(slot?.startTime);
              return dateSet.has(day) && day >= period.dateFrom && day <= period.dateTo &&
                util.toMs(slot.startTime) >= ctx.now && util.toMs(slot.endTime) > util.toMs(slot.startTime) &&
                slot.available !== false && !slot.notAvailable && !slot.disabled;
            });
          const picked = filters.pickSlots({
            slots, target: filterTarget, now: ctx.now, appointments: ctx.appointments, addressOf: () => s.clinic.address,
          });
          if (picked.skipped && !notes.includes(picked.skipped)) notes.push(picked.skipped);
          rejected = rejected.concat(picked.rejected);
          for (const slot of picked.ok) candidates.push({ ...r, complexResourceId: r.roomId, slot, address: s.clinic.address });
        }
      }
      candidates.sort((a, b) => util.toMs(a.slot.startTime) - util.toMs(b.slot.startTime));
      if (!available.length) notes.push('ЕМИАС пока не показывает врачей в выбранном отделении.');
      return { candidates, rejected, notes, action };
    }

    async function book(t, cand, ctx) {
      const s = t.source;
      const dates = new Set(selectedDays(t));
      if (!s?.clinic || !s.codes?.includes(String(cand.code)) || !dates.has(dayOf(cand.slot.startTime)) ||
          cand.clinic.id !== s.clinic.id || !sameAddress(cand.address, s.clinic.address) ||
          util.toMs(cand.slot.startTime) <= now()) return fail('Слот больше не соответствует выбранным условиям.', 'retry');
      if (ctx.active?.() === false) return fail('Поиск остановлен.', null);
      if (await profileKey() !== s.account) return fail('Выбран другой полис. Начните поиск заново.');
      if (ctx.appointments.some((a) => appointmentMatches(t, a, dates))) {
        return fail('Запись в этом отделении на одну из выбранных дат уже есть.');
      }
      const check = await api.post('v6/chatBot/check', {
        inquiryPurposeId: s.purpose.id, specialityId: cand.code, lpuId: cand.lpuId,
      });
      const rules = payload(check);
      if (!check.ok || !rules || typeof rules !== 'object' || Array.isArray(rules)) {
        return fail(check.explained?.message || 'ЕМИАС не подтвердил условия записи.', check.explained?.action || 'retry');
      }
      if (rules.inquiryPurposeBlock) {
        const when = cand.slot.startTime.slice(0, 16).replace('T', ' ');
        return fail('Найдено время ' + when + ' по адресу ' + cand.address + '. Для записи ЕМИАС просит пройти опрос на сайте.');
      }
      if (await profileKey() !== s.account) return fail('Выбран другой полис. Начните поиск заново.');
      if (ctx.active?.() === false) return fail('Поиск остановлен.', null);
      if (util.toMs(cand.slot.startTime) <= now()) return fail('Время приёма уже прошло.', 'retry');
      const body = {
        availableResourceId: cand.resourceId, complexResourceId: cand.roomId,
        startTime: cand.slot.startTime, endTime: cand.slot.endTime,
        inquiryPurposeId: s.purpose.id, inquiryPurposeCode: s.purpose.code,
      };
      if (cand.receptionTypeId) body.receptionTypeId = cand.receptionTypeId;
      if (rules.complaint?.id) body.complaintId = rules.complaint.id;
      const response = await api.post('v4/saOrchestrator/createAppointment', body, true);
      if (!response.ok && response.status > 0 && response.status < 500) {
        const action = response.status === 409 || response.status === 429 ? 'retry' : 'stopTarget';
        return fail(response.explained?.message || 'ЕМИАС не принял запись.', action);
      }
      const appointmentId = id(payload(response)?.appointmentId);
      const before = new Set(ctx.appointments.map((a) => id(a.id)));
      let records;
      try { records = await api.post(apptPath, {}); } catch { records = null; }
      const appointment = items(records?.ok && payload(records)?.appointment).find((a) =>
        !before.has(id(a.id)) && (!appointmentId || appointmentId === id(a.id)) && appointmentMatches(t, a, dates, cand));
      if (appointment) return { ok: true, verified: true, newAppointment: appointment, message: 'ЕМИАС подтвердил запись.' };
      return fail('ЕМИАС не подтвердил запись в списке приёмов. Проверьте раздел «Записи» перед повтором.');
    }

    return { purposes, departments, search, book };
  }

  const api = { createSpeciality };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);
