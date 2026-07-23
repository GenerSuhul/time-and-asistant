# Hikvision DeviceGateway API map (installed production build)

Date audited: 2026-07-17

Source of truth: `/opt/hikvision-devicegateway/protocol_debug/protocolList_group.json` from the DeviceGateway installation running on the VPS. All target-device calls are server-side and append `devIndex`; credentials must never leave the VPS.

## Transport and security boundary

- DeviceGateway API: `http://127.0.0.1:18080` from the VPS service.
- RenovaGT Node gateway: `http://127.0.0.1:8799`; loopback only.
- ISUP/EHome: `185.182.187.75:7661`, TCP and UDP.
- Browser calls Supabase/Edge Functions only. It never calls DeviceGateway and never receives its credentials.
- Request/response logs must redact passwords, EHome keys, `fingerData`, faces, photos and templates.

## DeviceGateway management

| Operation | Method and exact installed path | Installed payload / notes | Validation |
|---|---|---|---|
| Add device | `POST /ISAPI/ContentMgmt/DeviceMgmt/addDevice?format=json` | `{"DeviceInList":[{"Device":{"protocolType":"ehomeV5","EhomeParams":{"EhomeID":"<ID>","EhomeKey":"<KEY>"},"devName":"<NAME>","devType":"AccessControl"}}]}` | In production use; key is handled transiently/encrypted in provisioning outbox. |
| Delete device | `POST /ISAPI/ContentMgmt/DeviceMgmt/delDevice?format=json` | `{"DevIndexList":["<uuid>"]}` | Catalog-confirmed; not executed. |
| Edit device | `PUT /ISAPI/ContentMgmt/DeviceMgmt/modDevice?format=json` | `DeviceInfo` containing `devIndex`, `protocolType`, `EhomeParams`, `devName` | Catalog-confirmed; not executed. |
| Search device | `POST /ISAPI/ContentMgmt/DeviceMgmt/deviceList?format=json` | `SearchDescription.position`, `maxResult`, and `Filter` | Read-validated. Both production access-control devices are online. |

## Access Control protocol

Every path below uses `?format=json&devIndex=<uuid>` (or its equivalent query order).

| Operation | Method and exact installed path | Request root | Validation |
|---|---|---|---|
| Add person | `POST /ISAPI/AccessControl/UserInfo/Record` | `UserInfo` array with `employeeNo`, `name`, `Valid.beginTime/endTime` | Catalog-confirmed; existing adapter matches. |
| Edit person | `PUT /ISAPI/AccessControl/UserInfo/Modify` | Single `UserInfo` object | Catalog-confirmed; existing adapter matches. |
| Delete person | `PUT /ISAPI/AccessControl/UserInfoDetail/Delete` | `UserInfoDetail.mode=byEmployeeNo`, `EmployeeNoList` | Catalog-confirmed; existing adapter matches. |
| Search people | `POST /ISAPI/AccessControl/UserInfo/Search` | `UserInfoSearchCond` with stable `searchID`, zero-based `searchResultPosition`, `maxResults` | Read-validated with pagination: AD4776127 has 1 match; K43214566 reports 37 matches. |
| Add card | `POST /ISAPI/AccessControl/CardInfo/Record` | `CardInfo.employeeNo`, `cardNo` | Catalog-confirmed; existing adapter matches. |
| Search cards | `POST /ISAPI/AccessControl/CardInfo/Search` | `CardInfoSearchCond.EmployeeNoList` | Read-validated in production on 2026-07-23. Used for exact per-device reconciliation. |
| Delete card | `PUT /ISAPI/AccessControl/CardInfo/Delete` | `CardInfoDelCond.CardNoList` | Catalog-confirmed; existing adapter matches. |
| Capture fingerprint | `POST /ISAPI/AccessControl/CaptureFingerPrint` | `CaptureFingerPrintCond.fingerNo` | Catalog-confirmed; not executed. Response may contain raw template material. |
| Read fingerprint | `POST /ISAPI/AccessControl/FingerPrintUpload` | `FingerPrintCond.employeeNo`, `fingerPrintID` | Read-validated in production on 2026-07-23. The response is handled in memory and never logged or persisted. |
| Add fingerprint | `POST /ISAPI/AccessControl/FingerPrintDownload` | `FingerPrintCfg.employeeNo`, `fingerPrintID`, **`fingerData`** | Production-validated for origin-to-destination in-memory passthrough. The installed vendor uses “Download” to mean download into the target device. |
| Delete fingerprint | `PUT /ISAPI/AccessControl/FingerPrint/Delete` | `FingerPrintDelete.EmployeeNoDetail` | Catalog-confirmed; existing adapter matches. |
| Search history event | `POST /ISAPI/AccessControl/AcsEvent` | `AcsEventCond.searchID`, `searchResultPosition`, `maxResults`, `major`, `minor`, `startTime`, `endTime` | Live-validated on both production devices. The installed gateway caps pages at 30 even when 100 is requested. |
| Remote control door | `PUT /ISAPI/AccessControl/RemoteControl/door/<ID>` | `RemoteControlDoor.cmd` (`open` in installed example) | Catalog-confirmed; not executed during audit. |
| Get door parameters | `GET /ISAPI/AccessControl/Door/param/<doorID>` | none | Catalog-confirmed. |
| Set door parameters | `PUT /ISAPI/AccessControl/Door/param/<doorID>` | Installed example uses `{"doorName":"test"}` | Catalog-confirmed; not executed. |
| Get/set week plan | `GET/PUT /ISAPI/AccessControl/UserRightWeekPlanCfg/<weekPlanID>` | `UserRightWeekPlanCfg` | Catalog-confirmed. |
| Get/set holiday plan | `GET/PUT /ISAPI/AccessControl/UserRightHolidayPlanCfg/<holidayPlanID>` | `UserRightHolidayPlanCfg` | Catalog-confirmed. |
| Get/set holiday group | `GET/PUT /ISAPI/AccessControl/UserRightHolidayGroupCfg/<holidayGroupID>` | `UserRightHolidayGroupCfg` | Catalog-confirmed. |
| Get/set permission template | `GET/PUT /ISAPI/AccessControl/UserRightPlanTemplate/<planTemplateID>` | `UserRightPlanTemplate` | Catalog-confirmed; set adapter exists. |

## General target-device protocol

| Operation | Method and exact installed path | Validation |
|---|---|---|
| Get device information | `GET /ISAPI/System/deviceInfo?format=json&devIndex=<uuid>` | Read-validated on both devices. Models DS-K1T320MFWX and DS-K1T320MFX. |
| Set device information | `PUT /ISAPI/System/deviceInfo?format=json&devIndex=<uuid>` | Catalog-confirmed; not executed. |
| Get time | `GET /ISAPI/System/time?format=json&devIndex=<uuid>` | Read-validated; devices return UTC-06:00. |
| Set time | `PUT /ISAPI/System/time?format=json&devIndex=<uuid>` | `Time.localTime`, `Time.timeMode`; catalog-confirmed, not executed. |
| Get time zone | `GET /ISAPI/System/time/timeZone?devIndex=<uuid>` | Read-validated: `CST+6:00:00` on both devices (POSIX notation for UTC-06:00). |
| Set time zone | `PUT /ISAPI/System/time/timeZone?devIndex=<uuid>` | Plain time-zone string in installed example; not executed. |
| Reboot target device | `PUT /ISAPI/System/reboot?format=json&devIndex=<uuid>` | Catalog-confirmed; not executed. Existing adapter must be updated to use this verified path. |

## Events and platform attendance

- The installed DeviceGateway catalog exposes access events through `POST /ISAPI/AccessControl/AcsEvent` and callback listener configuration through `GET/POST/PUT/DELETE /ISAPI/Event/notification/httpHosts?format=json&devIndex=<uuid>`.
- No separate “Platform Attendance” configuration endpoint or canonical custom Check In/Check Out/Break mapping appears in the installed catalog. Therefore event direction must be derived only from fields actually returned by callbacks/history (`attendanceStatus`, major/minor and device-specific values), with unknown values preserved as `unknown`.
- Custom labels must be stored as an explicit RenovaGT mapping, never guessed from event order.
- Images, face data, fingerprint data and template-like fields must be removed from persisted raw payloads.
- The installed SDK sample also accepts `AcsEventSearchDescription` with a nested `AcsEventFilter`, but production uses the `AcsEventCond` body shown by API Testing. Responses can use either `AcsEvent` or `AcsEventSearchResult`; the adapter accepts both.
- `185.182.187.75:18080` is the public vendor UI/API. Processes on this VPS must call the same service through `http://127.0.0.1:18080`.
- The Renova Node gateway remains private on `127.0.0.1:8799`. Edge Functions enqueue `fetch_events` in Supabase; the private worker consumes the command and returns its summary in command metadata. Do not expose or proxy port 8799.

## Biometric decision

The installed API can read an existing template with `FingerPrintUpload` and add it to another device with `FingerPrintDownload`. RenovaGT performs this as a single backend-only in-memory transfer. Templates are never stored in Supabase, command payloads, audit rows, logs, frontend state or browser traffic. Every destination is re-read after transfer; a missing `fingerPrintID` is recorded as a partial failure instead of success.

## Audit of current RenovaGT implementation

Already present:

- production tables for employees, employee-device links, commands/logs, immutable raw access events, normalized attendance events, daily attendance, history cursors/runs and biometric jobs;
- RLS enabled; authenticated read requires an application role, admin writes are role-limited, raw access events are immutable to normal users;
- server-side command worker for person/card/delete/permission/event operations;
- callback and historical event ingestion with biometric/image field filtering;
- idempotency constraints for device events and employee daily attendance;
- daily/range calculation and Excel export Edge Functions;
- daily/range frontend report pages.

Missing or incomplete at this audit gate:

- no `employee_credentials` table;
- no `biometric_enrollment_sessions` lifecycle table;
- no worker/job for paginated person import or “sync all devices”;
- employee CRUD writes directly to Supabase and does not atomically create per-device commands;
- person search/card discovery/fingerprint count are not implemented in the DeviceGateway adapter;
- command errors are persisted without a central sanitizer;
- event mapping needs observed production values before Check In/Out/Break labels can be considered authoritative;
- reports do not yet expose all requested HikCentral-style filters/columns or PDF export;
- the schema table is named `daily_attendance` (not `attendance_daily`).
