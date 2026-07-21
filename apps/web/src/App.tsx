import { CircularProgress, Box } from "@mui/material";
import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { useSession } from "./hooks/useSession";
import { AuditPage } from "./pages/AuditPage";
import {
  AttendanceGroupsPage,
  BranchesPage,
  CompaniesPage,
  DepartmentsPage,
  DevicesPage,
  EmployeeDevicesPage,
  EmployeesPage,
  WorkSchedulesPage
} from "./pages/CrudPages";
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

function Protected({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();
  if (loading) {
    return (
      <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <CircularProgress />
      </Box>
    );
  }
  if (!session) return <Navigate to="/login" replace />;
  return <AppLayout>{children}</AppLayout>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Protected><DashboardPage /></Protected>} />
      <Route path="/companies" element={<Protected><CompaniesPage /></Protected>} />
      <Route path="/branches" element={<Protected><BranchesPage /></Protected>} />
      <Route path="/departments" element={<Protected><DepartmentsPage /></Protected>} />
      <Route path="/attendance-groups" element={<Protected><AttendanceGroupsPage /></Protected>} />
      <Route path="/work-schedules" element={<Protected><WorkSchedulesPage /></Protected>} />
      <Route path="/employees" element={<Protected><EmployeesPage /></Protected>} />
      <Route path="/devices" element={<Protected><DevicesPage /></Protected>} />
      <Route path="/employee-devices" element={<Protected><EmployeeDevicesPage /></Protected>} />
      <Route path="/commands" element={<Protected><DeviceCommandsPage /></Protected>} />
      <Route path="/live-events" element={<Protected><LiveEventsPage /></Protected>} />
      <Route path="/daily-report" element={<Protected><DailyReportPage /></Protected>} />
      <Route path="/range-report" element={<Protected><RangeReportPage /></Protected>} />
      <Route path="/manual-adjustments" element={<Protected><ManualAdjustmentsPage /></Protected>} />
      <Route path="/audit" element={<Protected><AuditPage /></Protected>} />
      <Route path="/users" element={<Protected><UsersPage /></Protected>} />
      <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/attendance-report-automation" element={<Protected><AttendanceReportAutomationPage /></Protected>} />
    </Routes>
  );
}
