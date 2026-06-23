import { PropsWithChildren } from "react";
import {
  AppBar,
  Box,
  Divider,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Typography,
  Button
} from "@mui/material";
import DashboardIcon from "@mui/icons-material/Dashboard";
import ApartmentIcon from "@mui/icons-material/Apartment";
import GroupsIcon from "@mui/icons-material/Groups";
import BadgeIcon from "@mui/icons-material/Badge";
import DevicesIcon from "@mui/icons-material/Devices";
import EventIcon from "@mui/icons-material/Event";
import FactCheckIcon from "@mui/icons-material/FactCheck";
import SettingsIcon from "@mui/icons-material/Settings";
import HistoryIcon from "@mui/icons-material/History";
import TuneIcon from "@mui/icons-material/Tune";
import { NavLink, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

const drawerWidth = 278;

const navItems = [
  { label: "Dashboard", to: "/", icon: <DashboardIcon /> },
  { label: "Empresas", to: "/companies", icon: <ApartmentIcon /> },
  { label: "Sucursales", to: "/branches", icon: <ApartmentIcon /> },
  { label: "Departamentos", to: "/departments", icon: <GroupsIcon /> },
  { label: "Grupos asistencia", to: "/attendance-groups", icon: <FactCheckIcon /> },
  { label: "Horarios", to: "/work-schedules", icon: <EventIcon /> },
  { label: "Empleados", to: "/employees", icon: <BadgeIcon /> },
  { label: "Dispositivos", to: "/devices", icon: <DevicesIcon /> },
  { label: "Asignaciones", to: "/employee-devices", icon: <GroupsIcon /> },
  { label: "Comandos", to: "/commands", icon: <TuneIcon /> },
  { label: "Eventos en vivo", to: "/live-events", icon: <HistoryIcon /> },
  { label: "Reporte diario", to: "/daily-report", icon: <FactCheckIcon /> },
  { label: "Reporte rango", to: "/range-report", icon: <FactCheckIcon /> },
  { label: "Ajustes manuales", to: "/manual-adjustments", icon: <TuneIcon /> },
  { label: "Auditoria", to: "/audit", icon: <HistoryIcon /> },
  { label: "Configuracion", to: "/settings", icon: <SettingsIcon /> }
];

export function AppLayout({ children }: PropsWithChildren) {
  const navigate = useNavigate();

  async function signOut() {
    await supabase.auth.signOut();
    navigate("/login");
  }

  return (
    <Box sx={{ display: "flex", minHeight: "100vh", bgcolor: "background.default" }}>
      <AppBar position="fixed" color="inherit" elevation={0} sx={{ borderBottom: 1, borderColor: "divider", zIndex: 1300 }}>
        <Toolbar>
          <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 800 }}>
            Control de Asistencia
          </Typography>
          <Button onClick={signOut}>Salir</Button>
        </Toolbar>
      </AppBar>
      <Drawer
        variant="permanent"
        sx={{
          width: drawerWidth,
          flexShrink: 0,
          "& .MuiDrawer-paper": { width: drawerWidth, boxSizing: "border-box" }
        }}
      >
        <Toolbar />
        <Divider />
        <List dense>
          {navItems.map((item) => (
            <ListItemButton
              key={item.to}
              component={NavLink}
              to={item.to}
              sx={{
                mx: 1,
                my: 0.25,
                borderRadius: 1,
                "&.active": { bgcolor: "primary.main", color: "primary.contrastText", "& .MuiListItemIcon-root": { color: "inherit" } }
              }}
            >
              <ListItemIcon>{item.icon}</ListItemIcon>
              <ListItemText primary={item.label} />
            </ListItemButton>
          ))}
        </List>
      </Drawer>
      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, p: 3 }}>
        <Toolbar />
        {children}
      </Box>
    </Box>
  );
}
