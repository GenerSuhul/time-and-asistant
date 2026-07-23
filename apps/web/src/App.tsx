import { CircularProgress, Box } from "@mui/material";
import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { useCurrentUserProfile } from "./hooks/useCurrentUserProfile";
import { useSession } from "./hooks/useSession";
import { canAccess, type AppPermission } from "./lib/accessControl";
import { AuditPage } from "./pages/AuditPage";
import {
  BranchesPage,
  CompaniesPage,
  DevicesPage,
  EmployeeDevicesPage,
  EmployeesPage,
  WorkSchedulesPage
} from "./pages/CrudPages";
import { DepartmentsPage } from "./pages/DepartmentsPage";
import { DailyReportPage } from "./pages/DailyReportPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DeviceCommandsPage } from "./pages/DeviceCommandsPage";
import { LiveEventsPage } from "./pages/LiveEventsPage";
import { LoginPage } from "./pages/LoginPage";
import { ManualAdjustmentsPage } from "./pages/ManualAdjustmentsPage";
import { RangeReportPage } from "./pages/RangeReportPage";
import { SettingsPage } from "./pages/SettingsPage";
import { UsersPage } from "./pages/UsersPage";
import { AttendanceReportAutomationPage } from "./pages/AttendanceReportAutomationPage";

function Protected({ children, permission }: { children: ReactNode; permission: AppPermission }) {
  const { session, loading } = useSession();
  const currentUser = useCurrentUserProfile();
  if (loading || (session && currentUser.isLoading)) {
    return (
      <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <CircularProgress />
      </Box>
    );
  }
  if (!session) return <Navigate to="/login" replace />;
  const roleKeys = (currentUser.data?.roles ?? []).map((role) => role.key);
  if (!canAccess(roleKeys, permission)) {
    if (permission !== "dashboard") return <Navigate to="/" replace />;
    return <AppLayout><Box sx={{ p: 2 }}>Tu cuenta no tiene un rol operativo activo. Solicita a IT que asigne IT o RRHH.</Box></AppLayout>;
  }
  return <AppLayout>{children}</AppLayout>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Protected permission="dashboard"><DashboardPage /></Protected>} />
      <Route path="/companies" element={<Protected permission="companies"><CompaniesPage /></Protected>} />
      <Route path="/branches" element={<Protected permission="branches"><BranchesPage /></Protected>} />
      <Route path="/departments" element={<Protected permission="departments"><DepartmentsPage /></Protected>} />
      <Route path="/work-schedules" element={<Protected permission="work_schedules"><WorkSchedulesPage /></Protected>} />
      <Route path="/employees" element={<Protected permission="employees"><EmployeesPage /></Protected>} />
      <Route path="/devices" element={<Protected permission="devices"><DevicesPage /></Protected>} />
      <Route path="/employee-devices" element={<Protected permission="employee_devices"><EmployeeDevicesPage /></Protected>} />
      <Route path="/commands" element={<Protected permission="commands"><DeviceCommandsPage /></Protected>} />
      <Route path="/live-events" element={<Protected permission="live_events"><LiveEventsPage /></Protected>} />
      <Route path="/daily-report" element={<Protected permission="daily_report"><DailyReportPage /></Protected>} />
      <Route path="/range-report" element={<Protected permission="range_report"><RangeReportPage /></Protected>} />
      <Route path="/manual-adjustments" element={<Protected permission="manual_adjustments"><ManualAdjustmentsPage /></Protected>} />
      <Route path="/audit" element={<Protected permission="audit"><AuditPage /></Protected>} />
      <Route path="/users" element={<Protected permission="users"><UsersPage /></Protected>} />
      <Route path="/settings" element={<Protected permission="settings"><SettingsPage /></Protected>} />
      <Route path="/attendance-report-automation" element={<Protected permission="attendance_report_automation"><AttendanceReportAutomationPage /></Protected>} />
    </Routes>
  );
}
