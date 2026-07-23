# Production credential reconciliation — 2026-07-23

## Scope and safety

- Production employee: `Gener Alexander Suhul Amador`
- `employee_id`: `00f3f4cd-322e-44c6-9d5a-4b8c4c4fa13d`
- Canonical Hikvision `employeeNo`: `8000000005`
- No employee, device, credential or audit row was deleted.
- No demo/mock data was created.
- No biometric template was logged, printed, sent to the browser or persisted.

The requested email `it.agrisystem@gmail.com` was not present on the employee
row. The unique employee was found by full name and then verified by UUID and
numeric Hikvision identifier.

## Root cause

The old assignment flow synchronized only person/card commands. Fingerprints
were captured locally with `CaptureFingerPrint` and written back to that same
device with `FingerPrintDownload`; no operation read an already-enrolled
template from an origin device. Consequently, the global employee summary
showed two fingerprints while destination devices contained only the person.

The global error banner also queried every command with an `error_message`,
including cancelled, closed staging and already-superseded history. Queue
payload validation existed only in the worker, so an older empty
`sync_person` command reached the queue before being rejected.

## Device truth after repair

Direct DeviceGateway verification confirmed the person `8000000005` on all 17
assigned devices. Card count is zero and face count is zero on every device.

- Poptún 1 (origin): 2 fingerprints.
- 15 destination devices: 2 fingerprints after replication.
- Poptún 2 canary: 2 fingerprints, verified before the broad rollout.
- Ixcán (`DS-K1T321MFWX`, firmware `V3.9.3 build 240701`): 1 fingerprint.
  Loading IDs 1 and 2 leaves only ID 2. The batch verifier reports
  `HIKVISION_FINGERPRINT_REPLICATION_PARTIAL` with requested `1,2` and verified
  `2`. Repeated production tests established this as a device/API-combination
  limit, not a transient retry condition.

The employee-level `fingerprint_count=2` is now the maximum verified count on a
physical device, not a sum and not an assumed count for every assignment.

## Traceability

- Initial 17-device verification trace:
  `3b1b3c3e-543f-47c6-8e96-14ed604b5288`
- Poptún 2 canary repair trace:
  `ebb8953b-2563-47e0-b42b-3338618e7ba9`
- Remaining 15-device rollout trace:
  `df65f5cf-2d8a-4deb-bd99-7b67964bb947`
- Ixcán batch-verification trace:
  `fcc59566-b202-48aa-a815-f2827a1e6f80`

Each replication audit stores source device, destination device, employee,
command, finger numbers, status and trace ID. It explicitly excludes biometric
material.

## Complete assignment and device role follow-up

The assignment flow now automatically enqueues
`repair_employee_credentials` after the last new-device person/card command.
That repair provisions and verifies person, Hikvision local role, card and all
known fingerprint IDs. Manual repair is no longer required after selecting a
new destination.

`employees.hikvision_is_admin` is the canonical device role.
`true` maps to `UserInfo.localUIRight=true`; `userType=normal` is not the
administrator flag on these terminals. Role truth is tracked independently as
`employee_device_credentials.credential_type='role'`.

- Gener is physically confirmed as administrator on 17/17 assigned devices.
- Katherine Ruiz (`employeeNo 3156528012`) is physically confirmed with
  fingerprint IDs 1 and 2 on `AC_TESTING` after backend-only replication from
  Poptún 1.
- Ixcán is truthfully represented as a device-limited state: 1 verified and
  usable fingerprint of the employee's 2 canonical templates. The historical
  partial-replication incident is resolved and retained for audit; it is not
  retried or displayed as an active failure.
- Person/role successes can resolve only person/role incidents; they can no
  longer supersede fingerprint failures.

Follow-up traces:

- Gener role repair: `4bb24d2e-750f-4e37-b5e4-4f5684810e6f`
- Katherine assignment repair: `e0d9ecfc-1364-418e-baa5-b69cdebe3fc1`
- Final device verification: `861d3397-d92f-4925-b839-e0d3647d2aaa`
- Ixcán capacity-aware verification: `5bd7cbdf-b1e3-4a94-82fb-06defcf23471`

## Ixcán incident resolution and operator UX

Migration `202607230032_ixcan_fingerprint_api_capacity.sql` records the
observed per-person remote provisioning target only in the Ixcán device
metadata. Reconciliation compares this device against one fingerprint while
preserving the employee's canonical count of two. The credential remains
yellow/informational in the UI, with a clear explanation that one verified
fingerprint is operational; it is never presented as two synchronized
templates.

The command history retains the original vendor code, full job UUID and trace
UUID for support and audit. Operator-facing screens translate the command and
known failures into Spanish and expose only a short technical reference in the
normal layout. Full identifiers remain available in a tooltip.

After deploying the capacity-aware worker, a live DeviceGateway reconciliation
completed successfully on `AC_RNV_IXCAN`: person synchronized, administrator
role confirmed, card not configured, one fingerprint verified, no credential
error, and zero active failed device commands system-wide.
