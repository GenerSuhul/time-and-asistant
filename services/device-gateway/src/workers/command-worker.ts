import { createAdapter } from "../adapters/factory.js";
import type { DeviceAdapter, DeviceCommand, DeviceRecord } from "../adapters/DeviceAdapter.js";
import { logger } from "../logger.js";
import { supabase } from "../supabase.js";
import { syncDeviceHistoryRange, type HistorySyncSummary } from "./history-sync-worker.js";
import { config } from "../config.js";

let running = false;

async function executeCommand(adapterCommand: DeviceCommand, device: DeviceRecord): Promise<HistorySyncSummary | void> {
  if (adapterCommand.command_type === "fetch_events") {
    const from = new Date(String(adapterCommand.payload.from ?? ""));
    const to = new Date(String(adapterCommand.payload.to ?? ""));
    if (!Number.isFinite(from.valueOf()) || !Number.isFinite(to.valueOf()) || from > to) {
      throw new Error("fetch_events requires a valid from/to range");
    }
    return syncDeviceHistoryRange({ from, to, deviceIds: [device.id], trigger: "command" });
  }
  const adapter = createAdapter(device);
  await adapter.connect();
  try {
    switch (adapterCommand.command_type) {
      case "sync_person":
      case "update_person":
        await adapter.syncPerson(adapterCommand);
        break;
      case "sync_device_people":
        if (!("searchPeople" in adapter)) throw new Error("Adapter does not support person search");
        {
          const people = await (adapter as DeviceAdapter & { searchPeople(): Promise<Record<string, unknown>[]> }).searchPeople();
          const upserted = await importPeople(device, people);
          await supabase.from("device_sync_logs").insert({
            device_id: device.id, command_id: adapterCommand.id, sync_type: "people", status: "success",
            records_found: people.length, records_upserted: upserted, started_at: new Date().toISOString(), completed_at: new Date().toISOString()
          });
        }
        break;
      case "delete_person":
        await adapter.deletePerson(adapterCommand);
        break;
      case "sync_card":
        await adapter.syncCard(adapterCommand);
        break;
      case "delete_card":
        if (!("deleteCard" in adapter)) throw new Error("Adapter does not support delete_card");
        await (adapter as DeviceAdapter & { deleteCard(command: DeviceCommand): Promise<void> }).deleteCard(adapterCommand);
        break;
      case "sync_face":
        await adapter.syncFace(adapterCommand);
        break;
      case "delete_face":
        if (!("deleteFace" in adapter)) throw new Error("Adapter does not support delete_face");
        await (adapter as DeviceAdapter & { deleteFace(command: DeviceCommand): Promise<void> }).deleteFace(adapterCommand);
        break;
      case "enroll_fingerprint":
        await adapter.requestFingerprintEnrollment(adapterCommand);
        break;
      case "delete_fingerprint":
        if (!("deleteFingerprint" in adapter)) throw new Error("Adapter does not support delete_fingerprint");
        await (adapter as DeviceAdapter & { deleteFingerprint(command: DeviceCommand): Promise<void> }).deleteFingerprint(adapterCommand);
        break;
      case "remote_door":
        if (!("remoteDoor" in adapter)) throw new Error("Adapter does not support remote_door");
        await (adapter as DeviceAdapter & { remoteDoor(command: DeviceCommand): Promise<void> }).remoteDoor(adapterCommand);
        break;
      case "sync_permission_schedule":
        if (!("syncPermissionSchedule" in adapter)) throw new Error("Adapter does not support sync_permission_schedule");
        await (adapter as DeviceAdapter & { syncPermissionSchedule(command: DeviceCommand): Promise<void> }).syncPermissionSchedule(adapterCommand);
        break;
      case "reboot":
        await adapter.rebootDevice(adapterCommand);
        break;
      case "sync_time":
        await adapter.syncTime(adapterCommand);
        break;
      default:
        throw new Error(`Unsupported command type: ${adapterCommand.command_type}`);
    }
  } finally {
    await adapter.disconnect();
  }
}

async function importPeople(device: DeviceRecord & { branch_id?: string | null }, people: Record<string, unknown>[]) {
  if (!device.branch_id) throw new Error("Device must be assigned to a branch before importing people");
  const { data: branch, error: branchError } = await supabase.from("branches").select("company_id").eq("id", device.branch_id).single();
  if (branchError) throw branchError;

  let upserted = 0;
  for (const person of people) {
    const employeeNo = String(person.employeeNo ?? person.employeeNoString ?? "").trim();
    if (!employeeNo) continue;
    const [linkResult, canonicalResult, externalResult] = await Promise.all([
      supabase.from("employee_devices").select("employees:employee_id(id,metadata)")
        .eq("device_id", device.id).eq("external_person_id", employeeNo).maybeSingle(),
      supabase.from("employees").select("id,metadata").eq("company_id", branch.company_id)
        .eq("hikvision_employee_no", employeeNo).maybeSingle(),
      supabase.from("employees").select("id,metadata").eq("company_id", branch.company_id)
        .eq("external_employee_id", employeeNo).maybeSingle()
    ]);
    for (const result of [linkResult, canonicalResult, externalResult]) if (result.error) throw result.error;
    const linked = Array.isArray(linkResult.data?.employees) ? linkResult.data.employees[0] : linkResult.data?.employees;
    const existing = linked ?? canonicalResult.data ?? externalResult.data;
    let employeeId = existing?.id;
    const fingerprintCount = safeCount(person.numOfFP ?? person.fingerPrintNum ?? person.fingerprintCount);
    const faceCount = safeCount(person.numOfFace ?? person.faceNum ?? person.faceCount);
    const cardCount = safeCount(person.numOfCard ?? person.cardNum ?? person.cardCount ?? (person.cardNo ? 1 : 0));
    const cardNumber = typeof person.cardNo === "string" && person.cardNo.trim() ? person.cardNo.trim() : null;
    const credentialStatus = {
      card: cardCount > 0 ? "enrolled" : "none", fingerprint: fingerprintCount > 0 ? "enrolled" : "none",
      face: faceCount > 0 ? "enrolled" : "none", pin: "unknown"
    };
    if (employeeId) {
      const { error } = await supabase.from("employees").update({
        full_name: String(person.name ?? employeeNo).trim() || employeeNo,
        card_number: cardNumber ?? undefined,
        fingerprint_count: fingerprintCount,
        fingerprint_status: fingerprintCount > 0 ? "enrolled" : "none",
        face_status: faceCount > 0 ? "enrolled" : "none",
        credential_status: credentialStatus,
        metadata: { ...(existing?.metadata ?? {}), source: "devicegateway", devicegateway_last_import_at: new Date().toISOString(),
          devicegateway_counts: { cards: cardCount, fingerprints: fingerprintCount, faces: faceCount } }
      }).eq("id", employeeId);
      if (error) throw error;
    } else {
      const fullName = String(person.name ?? employeeNo).trim() || employeeNo;
      const hikvisionEmployeeNo = /^\d+$/.test(employeeNo)
        ? employeeNo
        : await allocateHikvisionEmployeeNo(branch.company_id);
      const { data: created, error } = await supabase.from("employees").insert({
        company_id: branch.company_id,
        branch_id: device.branch_id,
        employee_code: employeeNo,
        external_employee_id: employeeNo,
        hikvision_employee_no: hikvisionEmployeeNo,
        full_name: fullName,
        card_number: cardNumber,
        fingerprint_count: fingerprintCount,
        fingerprint_status: fingerprintCount > 0 ? "enrolled" : "none",
        face_status: faceCount > 0 ? "enrolled" : "none",
        credential_status: credentialStatus,
        metadata: { source: "devicegateway", devicegateway_last_import_at: new Date().toISOString(),
          devicegateway_counts: { cards: cardCount, fingerprints: fingerprintCount, faces: faceCount } }
      }).select("id").single();
      if (error) throw error;
      employeeId = created.id;
    }
    const { error: linkError } = await supabase.from("employee_devices").upsert({
      employee_id: employeeId,
      device_id: device.id,
      external_person_id: employeeNo,
      sync_status: "success",
      last_synced_at: new Date().toISOString(),
      last_error: null
    }, { onConflict: "employee_id,device_id" });
    if (linkError) throw linkError;
    upserted += 1;
  }
  return upserted;
}

const safeCount = (value: unknown) => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);

export async function runCommandWorkerOnce() {
  if (running) return;
  running = true;

  try {
    const { data: expiredSessions, error: expiredError } = await supabase.from("employee_creation_sessions")
      .select("id").in("status", ["draft", "enrolling", "captured"]).lt("expires_at", new Date().toISOString()).limit(20);
    if (expiredError) throw expiredError;
    for (const session of expiredSessions ?? []) {
      const { error: cleanupError } = await supabase.rpc("admin_cancel_employee_creation_session", {
        p_session_id: session.id, p_requested_by: null, p_reason: "expired"
      });
      if (cleanupError) logger.error({ err: cleanupError, creationSessionId: session.id }, "Expired employee creation cleanup failed");
    }
    await supabase.from("biometric_enrollment_sessions").update({
      status: "timeout", completed_at: new Date().toISOString(), error_message: "Fingerprint capture timed out"
    }).in("status", ["pending", "processing"]).lt("created_at", new Date(Date.now() - 2 * 60 * 1000).toISOString());
    const { data: commands, error } = await supabase
      .from("device_commands")
          .select("*, devices:device_id(id, branch_id, name, protocol, device_identifier, serial_number, dev_index, metadata)")
      .eq("status", "pending")
      .lte("next_run_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(10);

    if (error) throw error;

    for (const command of commands ?? []) {
      if (command.depends_on_command_id) {
        const { data: dependency, error: dependencyError } = await supabase.from("device_commands")
          .select("status,error_message").eq("id", command.depends_on_command_id).maybeSingle();
        if (dependencyError) throw dependencyError;
        if (!dependency || ["failed", "cancelled"].includes(dependency.status)) {
          const dependencyMessage = dependency?.error_message || "Required preparation job was not available";
          await supabase.from("device_commands").update({ status: "failed", processed_at: new Date().toISOString(),
            error_message: `Preparation failed: ${dependencyMessage}` }).eq("id", command.id).eq("status", "pending");
          if (command.command_type === "enroll_fingerprint" && command.payload?.session_id) {
            await supabase.from("biometric_enrollment_sessions").update({ status: "failed", completed_at: new Date().toISOString(),
              status_detail: "No se pudo preparar la persona", error_message: dependencyMessage }).eq("id", command.payload.session_id);
            if (command.payload?.creation_session_id) await supabase.from("employee_creation_sessions").update({ status: "failed",
              error_code: "HIKVISION_PERSON_STAGE_FAILED", error_message: dependencyMessage }).eq("id", command.payload.creation_session_id);
          }
          continue;
        }
        if (dependency.status !== "success") continue;
      }
      const attempts = (command.attempts ?? 0) + 1;
      await supabase
        .from("device_commands")
        .update({ status: "processing", attempts, locked_at: new Date().toISOString() })
        .eq("id", command.id)
        .eq("status", "pending");

      try {
        if (command.employee_id) await setEmployeeDeviceState(command.employee_id, command.device_id, "processing");
        if (command.command_type === "enroll_fingerprint" && command.payload?.session_id) {
          await supabase.from("biometric_enrollment_sessions").update({ status: "processing", started_at: new Date().toISOString(),
            worker_started_at: new Date().toISOString(), status_detail: "Worker tomó el trabajo; esperando dispositivo", error_message: null }).eq("id", command.payload.session_id);
          if (command.payload?.creation_session_id) await supabase.from("employee_creation_sessions").update({
            status: "enrolling", error_code: null, error_message: null
          }).eq("id", command.payload.creation_session_id);
        }
        if (command.command_type === "enroll_fingerprint" && command.payload?.session_id) await supabase.from("biometric_enrollment_sessions").update({
          device_request_started_at: new Date().toISOString(), status_detail: "Esperando dedo en el dispositivo"
        }).eq("id", command.payload.session_id);
        const commandResult = await executeCommand(
          {
            id: command.id,
            command_type: command.command_type,
            payload: command.payload ?? {}
          },
          command.devices as DeviceRecord
        );

        if (commandResult) {
          await supabase.from("device_commands").update({
            metadata: { ...(command.metadata ?? {}), attendance_sync_result: commandResult }
          }).eq("id", command.id);
          if (commandResult.errors.length > 0) throw new Error(commandResult.errors[0]?.error ?? "Historical sync failed");
        }

        await supabase
          .from("device_commands")
          .update({ status: "success", processed_at: new Date().toISOString(), error_message: null })
          .eq("id", command.id);

        await supabase.from("device_command_logs").insert({
          device_command_id: command.id,
          device_id: command.device_id,
          status: "success",
          message: "Command processed successfully"
        });
        if (command.employee_id) await setEmployeeDeviceState(command.employee_id, command.device_id, "success");
        if (command.command_type === "enroll_fingerprint" && command.payload?.session_id) {
          await supabase.from("biometric_enrollment_sessions").update({ status: "success", completed_at: new Date().toISOString(),
            device_response_at: new Date().toISOString(), status_detail: "Huella capturada", error_message: null }).eq("id", command.payload.session_id);
          if (command.payload?.creation_session_id) {
            await supabase.from("employee_creation_sessions").update({ status: "captured", error_code: null, error_message: null }).eq("id", command.payload.creation_session_id);
          } else if (command.employee_id) {
            const { data: current } = await supabase.from("employees").select("fingerprint_count,credential_status").eq("id", command.employee_id).single();
            await supabase.from("employees").update({ fingerprint_status: "enrolled", fingerprint_count: Math.max(1, Number(current?.fingerprint_count ?? 0)),
              credential_status: { ...(current?.credential_status ?? {}), fingerprint: "enrolled" } }).eq("id", command.employee_id);
            if (command.payload?.previous_employee_no) {
              await supabase.from("employee_devices").update({
                external_person_id: String(command.payload.employee_no), sync_status: "success", last_error: null,
                last_synced_at: new Date().toISOString()
              }).eq("employee_id", command.employee_id).eq("device_id", command.device_id);
              await enqueueIdentifierCleanup(command, String(command.payload.previous_employee_no));
            }
          }
        }
      } catch (error) {
        const shouldRetry = !["fetch_events", "enroll_fingerprint"].includes(command.command_type) && attempts < (command.max_attempts ?? 5);
        const backoffSeconds = Math.min(300, 2 ** attempts * 5);
        const safeError = sanitizeError(error);
        await supabase
          .from("device_commands")
          .update({
            status: shouldRetry ? "pending" : "failed",
            next_run_at: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
            error_message: safeError
          })
          .eq("id", command.id);

        await supabase.from("device_command_logs").insert({
          device_command_id: command.id,
          device_id: command.device_id,
          status: shouldRetry ? "pending" : "failed",
          message: safeError
        });
        if (command.employee_id) await setEmployeeDeviceState(command.employee_id, command.device_id, shouldRetry ? "pending" : "failed", safeError);
        if (!shouldRetry && command.command_type === "enroll_fingerprint" && command.payload?.session_id) {
          await supabase.from("biometric_enrollment_sessions").update({ status: "failed", completed_at: new Date().toISOString(),
            device_response_at: new Date().toISOString(), status_detail: "Fallo de captura", error_message: safeError }).eq("id", command.payload.session_id);
          if (command.payload?.creation_session_id) await supabase.from("employee_creation_sessions").update({
            status: "failed", error_code: "HIKVISION_ENROLLMENT_FAILED", error_message: safeError
          }).eq("id", command.payload.creation_session_id);
          else if (command.employee_id) {
            await supabase.from("employees").update({ fingerprint_status: "failed" }).eq("id", command.employee_id);
            if (command.payload?.previous_employee_no) await enqueueIdentifierCleanup(command, String(command.payload.employee_no));
          }
        } else if (shouldRetry && command.command_type === "enroll_fingerprint" && command.payload?.session_id) {
          await supabase.from("biometric_enrollment_sessions").update({ status_detail: `Reintento ${attempts} programado`, error_message: safeError }).eq("id", command.payload.session_id);
        }
        if (!shouldRetry && command.command_type === "sync_device_people") {
          await supabase.from("device_sync_logs").insert({ device_id: command.device_id, command_id: command.id,
            sync_type: "people", status: "failed", error_message: safeError, completed_at: new Date().toISOString() });
        }
      }
    }
  } finally {
    running = false;
  }
}

async function allocateHikvisionEmployeeNo(companyId: string) {
  const { data, error } = await supabase.rpc("allocate_hikvision_employee_no", { p_company_id: companyId });
  if (error) throw error;
  const value = String(data ?? "");
  if (!/^\d+$/.test(value)) throw new Error("HIKVISION_EMPLOYEE_NO_ALLOCATION_FAILED");
  return value;
}

async function enqueueIdentifierCleanup(command: any, employeeNo: string) {
  if (!employeeNo) return;
  const { error } = await supabase.from("device_commands").insert({
    device_id: command.device_id,
    employee_id: command.employee_id ?? null,
    command_type: "delete_person",
    requested_by: command.requested_by ?? null,
    payload: { employee_no: employeeNo, identifier_migration_cleanup: true, trace_id: command.payload?.trace_id }
  });
  if (error && error.code !== "23505") logger.error({ err: error, commandId: command.id, deviceId: command.device_id }, "Identifier cleanup enqueue failed");
}

async function setEmployeeDeviceState(employeeId: string, deviceId: string, status: string, lastError: string | null = null) {
  await supabase.from("employee_devices").update({
    sync_status: status,
    last_attempt_at: new Date().toISOString(),
    last_synced_at: status === "success" ? new Date().toISOString() : undefined,
    last_error: lastError
  }).eq("employee_id", employeeId).eq("device_id", deviceId);
}

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/fingerData|finger_data|template|password|secret|service_role|api[_-]?key/i.test(message)) return "Sensitive DeviceGateway operation failed; see sanitized server diagnostics";
  return message.replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted]").slice(0, 500);
}

export function startCommandWorker() {
  void runCommandWorkerOnce().catch((error) => logger.error({ err: error }, "Command worker failed"));
  setInterval(() => {
    void runCommandWorkerOnce().catch((error) => logger.error({ err: error }, "Command worker failed"));
  }, config.COMMAND_WORKER_INTERVAL_MS);
}
