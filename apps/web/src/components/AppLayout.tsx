import { FormEvent, PropsWithChildren, useState } from "react";
import {
  AppBar,
  Avatar,
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
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
import MenuIcon from "@mui/icons-material/Menu";
import SearchIcon from "@mui/icons-material/Search";
import LogoutIcon from "@mui/icons-material/Logout";
import { NavLink, useNavigate } from "react-router-dom";
import { useSession } from "../hooks/useSession";
import { supabase } from "../lib/supabase";

const desktopDrawerWidth = 96;
const mobileDrawerWidth = 264;

const navSections = [
  [
    { label: "Dashboard", to: "/", icon: <DashboardIcon /> },
    { label: "Empresas", to: "/companies", icon: <ApartmentIcon /> },
    { label: "Sucursales", to: "/branches", icon: <ApartmentIcon /> },
    { label: "Departamentos", to: "/departments", icon: <GroupsIcon /> },
    { label: "Grupos asistencia", to: "/attendance-groups", icon: <FactCheckIcon /> },
    { label: "Horarios", to: "/work-schedules", icon: <EventIcon /> }
  ],
  [
    { label: "Empleados", to: "/employees", icon: <BadgeIcon /> },
    { label: "Dispositivos", to: "/devices", icon: <DevicesIcon /> },
    { label: "Asignaciones", to: "/employee-devices", icon: <GroupsIcon /> },
    { label: "Comandos", to: "/commands", icon: <TuneIcon /> },
    { label: "Eventos en vivo", to: "/live-events", icon: <HistoryIcon /> }
  ],
  [
    { label: "Reporte diario", to: "/daily-report", icon: <FactCheckIcon /> },
    { label: "Reporte rango", to: "/range-report", icon: <FactCheckIcon /> },
    { label: "Ajustes manuales", to: "/manual-adjustments", icon: <TuneIcon /> },
    { label: "Auditoria", to: "/audit", icon: <HistoryIcon /> },
    { label: "Configuracion", to: "/settings", icon: <SettingsIcon /> }
  ]
];

export function AppLayout({ children }: PropsWithChildren) {
  const navigate = useNavigate();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { session } = useSession();
  const drawerWidth = isDesktop ? desktopDrawerWidth : mobileDrawerWidth;

  async function signOut() {
    await supabase.auth.signOut();
    navigate("/login");
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const text = search.trim();
    if (!text) return;
    navigate(`/employees?search=${encodeURIComponent(text)}`);
  }

  const logo = (
    <Stack alignItems="center" spacing={0.6}>
      <Typography sx={{ fontSize: 27, fontWeight: 800, lineHeight: 0.9, letterSpacing: -1.5, color: "#111217" }}>
        ac
      </Typography>
      <Box sx={{ width: 22, height: 3, borderRadius: 999, bgcolor: "primary.main" }} />
    </Stack>
  );

  const drawer = (
    <Box sx={{ display: "flex", minHeight: "100%", flexDirection: "column", bgcolor: "#ffffff" }}>
      <Stack alignItems={isDesktop ? "center" : "flex-start"} spacing={1.5} sx={{ px: 2, py: 2.5 }}>
        {isDesktop ? (
          logo
        ) : (
          <Stack direction="row" alignItems="center" spacing={1.5}>
            {logo}
            <Box>
              <Typography variant="subtitle1">Renovagt</Typography>
              <Typography variant="caption" color="text.secondary">
                Control de asistencia
              </Typography>
            </Box>
          </Stack>
        )}
      </Stack>
      <Divider />
      <Stack component="nav" spacing={2} sx={{ flex: 1, overflowY: "auto", px: isDesktop ? 1.25 : 1.5, py: 2 }}>
        {navSections.map((section, sectionIndex) => (
          <List key={sectionIndex} dense disablePadding sx={{ display: "grid", gap: 0.5 }}>
            {section.map((item) => {
              const button = (
                <ListItemButton
                  component={NavLink}
                  to={item.to}
                  end={item.to === "/"}
                  onClick={() => setMobileOpen(false)}
                  sx={{
                    minHeight: isDesktop ? 46 : 42,
                    justifyContent: isDesktop ? "center" : "flex-start",
                    px: isDesktop ? 0 : 1.4,
                    color: "#9aa0aa",
                    "& .MuiListItemIcon-root": {
                      minWidth: isDesktop ? 0 : 38,
                      color: "inherit"
                    },
                    "& .MuiListItemText-primary": {
                      fontSize: 13,
                      fontWeight: 600
                    },
                    "&:hover": {
                      bgcolor: "#f5f6fb",
                      color: "text.primary"
                    },
                    "&.active": {
                      bgcolor: alpha(theme.palette.primary.main, 0.08),
                      color: "primary.main",
                      "& .MuiListItemIcon-root": { color: "inherit" }
                    }
                  }}
                >
                  <ListItemIcon>{item.icon}</ListItemIcon>
                  {!isDesktop && <ListItemText primary={item.label} />}
                </ListItemButton>
              );

              return isDesktop ? (
                <Tooltip key={item.to} title={item.label} placement="right">
                  {button}
                </Tooltip>
              ) : (
                <Box key={item.to}>{button}</Box>
              );
            })}
          </List>
        ))}
      </Stack>
      <Divider />
      <Stack alignItems={isDesktop ? "center" : "flex-start"} sx={{ p: 2 }}>
        {isDesktop ? (
          <Tooltip title={session?.user.email ?? "Sesion activa"} placement="right">
            <Avatar sx={{ width: 36, height: 36, bgcolor: "primary.main", fontSize: 13, fontWeight: 700 }}>
              {(session?.user.email ?? "U").slice(0, 1).toUpperCase()}
            </Avatar>
          </Tooltip>
        ) : (
          <Stack direction="row" spacing={1.25} alignItems="center">
            <Avatar sx={{ width: 34, height: 34, bgcolor: "primary.main", fontSize: 13, fontWeight: 700 }}>
              {(session?.user.email ?? "U").slice(0, 1).toUpperCase()}
            </Avatar>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>
                Administrador
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {session?.user.email ?? "Sesion activa"}
              </Typography>
            </Box>
          </Stack>
        )}
      </Stack>
    </Box>
  );

  return (
    <Box sx={{ display: "flex", minHeight: "100vh", bgcolor: "background.default" }}>
      <AppBar
        position="fixed"
        color="inherit"
        elevation={0}
        sx={{
          borderBottom: 1,
          borderColor: "divider",
          ml: { md: `${desktopDrawerWidth}px` },
          width: { md: `calc(100% - ${desktopDrawerWidth}px)` },
          zIndex: theme.zIndex.drawer + 1
        }}
      >
        <Toolbar sx={{ gap: 1.5, minHeight: { xs: 64, sm: 76 }, px: { xs: 2, md: 3 } }}>
          {!isDesktop && (
            <IconButton onClick={() => setMobileOpen(true)} aria-label="abrir menu">
              <MenuIcon />
            </IconButton>
          )}
          <Box component="form" onSubmit={submitSearch} sx={{ display: { xs: "none", sm: "block" }, maxWidth: 540, flex: 1 }}>
            <TextField
              size="small"
              placeholder="Buscar empleado"
              fullWidth
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                )
              }}
            />
          </Box>
          <Box sx={{ flex: 1, display: { xs: "block", sm: "none" } }} />
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip
              size="small"
              label="Produccion"
              variant="outlined"
              sx={{ display: { xs: "none", md: "inline-flex" }, color: "text.secondary", borderColor: "divider" }}
            />
            <Button color="inherit" startIcon={<LogoutIcon fontSize="small" />} onClick={signOut} sx={{ color: "text.primary" }}>
              Salir
            </Button>
          </Stack>
        </Toolbar>
      </AppBar>
      <Box component="nav" sx={{ width: { md: desktopDrawerWidth }, flexShrink: { md: 0 } }} aria-label="navegacion principal">
        <Drawer
          variant={isDesktop ? "permanent" : "temporary"}
          open={isDesktop || mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{
            "& .MuiDrawer-paper": {
              width: drawerWidth,
              boxSizing: "border-box",
              borderRight: "1px solid",
              borderColor: "divider"
            }
          }}
        >
          {drawer}
        </Drawer>
      </Box>
      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, px: { xs: 2, lg: 3 }, py: { xs: 2, lg: 2.5 } }}>
        <Toolbar sx={{ minHeight: { xs: 64, sm: 76 } }} />
        {children}
      </Box>
    </Box>
  );
}
