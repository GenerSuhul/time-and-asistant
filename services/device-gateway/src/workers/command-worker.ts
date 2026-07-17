import { createAdapter } from "../adapters/factory.js";
import type { DeviceAdapter, DeviceCommand, DeviceRecord } from "../adapters/DeviceAdapter.js";
import { logger } from "../logger.js";
import { supabase } from "../supabase.js";
import { processGatewayEvent } from "../services/event-ingestion.js";

let running = false;

async function executeCommand(adapterCommand: DeviceCommand, device: DeviceRecord) {
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
        await importPeople(device, await (adapter as DeviceAdapter & { searchPeople(): Promise<Record<string, unknown>[]> }).searchPeople());
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
      case "fetch_events":
        for (const event of await adapter.fetchHistoricalEvents(adapterCommand)) await processGatewayEvent(event, { source: "history" });
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

  for (const person of people) {
    const employeeNo = String(person.employeeNo ?? person.employeeNoString ?? "").trim();
    if (!employeeNo) continue;
    const { data: existing, error: existingError } = await supabase
      .from("employees").select("id,metadata").eq("company_id", branch.company_id).eq("external_employee_id", employeeNo).maybeSingle();
    if (existingError) throw existingError;
    let employeeId = existing?.id;
    if (employeeId) {
      const { error } = await supabase.from("employees").update({
        fingerprint_count: safeCount(person.numOfFP ?? person.fingerPrintNum),
        fingerprint_status: safeCount(person.numOfFP ?? person.fingerPrintNum) > 0 ? "enrolled" : "none",
        metadata: { ...(existing?.metadata ?? {}), devicegateway_last_import_at: new Date().toISOString() }
      }).eq("id", employeeId);
      if (error) throw error;
    } else {
      const fullName = String(person.name ?? employeeNo).trim() || employeeNo;
      const { data: created, error } = await supabase.from("employees").insert({
        company_id: branch.company_id,
        branch_id: device.branch_id,
        employee_code: employeeNo,
        external_employee_id: employeeNo,
        full_name: fullName,
        card_number: typeof person.cardNo === "string" ? person.cardNo : null,
        fingerprint_count: safeCount(person.numOfFP ?? person.fingerPrintNum),
        fingerprint_status: safeCount(person.numOfFP ?? person.fingerPrintNum) > 0 ? "enrolled" : "none",
        metadata: { source: "devicegateway", devicegateway_last_import_at: new Date().toISOString() }
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
  }
}

const safeCount = (value: unknown) => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);

export async function runCommandWorkerOnce() {
  if (running) return;
  running = true;

  try {
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
      const attempts = (command.attempts ?? 0) + 1;
      await supabase
        .from("device_commands")
        .update({ status: "processing", attempts, locked_at: new Date().toISOString() })
        .eq("id", command.id)
        .eq("status", "pending");

      try {
        if (command.employee_id) await setEmployeeDeviceState(command.employee_id, command.device_id, "processing");
        if (command.command_type === "enroll_fingerprint" && command.payload?.session_id) {
          await supabase.from("biometric_enrollment_sessions").update({ status: "processing", started_at: new Date().toISOString(), error_message: null }).eq("id", command.payload.session_id);
        }
        await executeCommand(
          {
            id: command.id,
            command_type: command.command_type,
            payload: command.payload ?? {}
          },
          command.devices as DeviceRecord
        );

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
          await supabase.from("biometric_enrollment_sessions").update({ status: "success", completed_at: new Date().toISOString(), error_message: null }).eq("id", command.payload.session_id);
          await supabase.from("employees").update({ fingerprint_status: "enrolled" }).eq("id", command.employee_id);
        }
      } catch (error) {
        const shouldRetry = attempts < (command.max_attempts ?? 5);
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
          await supabase.from("biometric_enrollment_sessions").update({ status: "failed", completed_at: new Date().toISOString(), error_message: safeError }).eq("id", command.payload.session_id);
          await supabase.from("employees").update({ fingerprint_status: "failed" }).eq("id", command.employee_id);
        }
      }
    }
  } finally {
    running = false;
  }
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
  if (/fingerData|template|biometric|password|secret|key/i.test(message)) return "Sensitive DeviceGateway operation failed; see sanitized server diagnostics";
  return message.replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted]").slice(0, 500);
}

export function startCommandWorker() {
  void runCommandWorkerOnce().catch((error) => logger.error({ err: error }, "Command worker failed"));
  setInterval(() => {
    void runCommandWorkerOnce().catch((error) => logger.error({ err: error }, "Command worker failed"));
  }, 5000);
}
