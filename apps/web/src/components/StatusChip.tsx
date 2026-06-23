import { Chip } from "@mui/material";

const statusColor: Record<string, "default" | "primary" | "secondary" | "success" | "warning" | "error" | "info"> = {
  complete: "success",
  late: "warning",
  incomplete: "error",
  absent: "error",
  early_leave: "warning",
  day_off: "info",
  holiday: "secondary",
  leave: "secondary",
  error: "error",
  online: "success",
  offline: "default",
  pending: "warning",
  processing: "info",
  success: "success",
  failed: "error",
  cancelled: "default",
  active: "success",
  inactive: "default",
  suspended: "warning"
};

export function StatusChip({ value }: { value?: string | null }) {
  if (!value) return <Chip size="small" label="-" />;
  return <Chip size="small" color={statusColor[value] ?? "default"} label={value.replaceAll("_", " ")} />;
}
