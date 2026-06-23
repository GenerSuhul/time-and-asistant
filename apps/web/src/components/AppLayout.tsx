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
import ManageAccountsIcon from "@mui/icons-material/ManageAccounts";
import { NavLink, useNavigate } from "react-router-dom";
import { displayName, useCurrentUserProfile } from "../hooks/useCurrentUserProfile";
import { useSession } from "../hooks/useSession";
import { supabase } from "../lib/supabase";

const desktopDrawerWidth = 96;
const desktopExpandedDrawerWidth = 264;
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
    { label: "Usuarios y roles", to: "/users", icon: <ManageAccountsIcon /> },
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
  const [desktopExpanded, setDesktopExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const { session } = useSession();
  const currentUser = useCurrentUserProfile();
  const currentName = displayName(currentUser.data);
  const currentEmail = currentUser.data?.profile?.email ?? session?.user.email ?? "Sesion activa";
  const isExpanded = !isDesktop || desktopExpanded;
  const activeDesktopWidth = desktopExpanded ? desktopExpandedDrawerWidth : desktopDrawerWidth;
  const drawerWidth = isDesktop ? activeDesktopWidth : mobileDrawerWidth;

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

  function openSidebarFromItem() {
    if (isDesktop && !desktopExpanded) setDesktopExpanded(true);
    setMobileOpen(false);
  }

  const logo = (
    <Stack alignItems="center" spacing={0.6}>
      <Typography sx={{ fontSize: 27, fontWeight: 800, lineHeight: 0.9, letterSpacing: 0, color: "#111217" }}>
        ac
      </Typography>
      <Box sx={{ width: 22, height: 3, borderRadius: 999, bgcolor: "primary.main" }} />
    </Stack>
  );

  const drawer = (
    <Box
      onMouseLeave={() => {
        if (isDesktop) setDesktopExpanded(false);
      }}
      sx={{ display: "flex", minHeight: "100%", flexDirection: "column", bgcolor: "#ffffff" }}
    >
      <Stack
        direction={isExpanded ? "row" : "column"}
        alignItems="center"
        justifyContent={isExpanded ? "flex-start" : "center"}
        spacing={1.2}
        sx={{ px: 2, py: 2.5 }}
      >
        <Stack direction={isExpanded ? "row" : "column"} alignItems="center" spacing={isExpanded ? 1.4 : 0.6}>
          {logo}
          {isExpanded && (
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle1">Renovagt</Typography>
              <Typography variant="caption" color="text.secondary">
                Control de asistencia
              </Typography>
            </Box>
          )}
        </Stack>
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
                  onClick={openSidebarFromItem}
                  sx={{
                    minHeight: isDesktop ? 46 : 42,
                    justifyContent: isExpanded ? "flex-start" : "center",
                    px: isExpanded ? 1.4 : 0,
                    color: "#9aa0aa",
                    "& .MuiListItemIcon-root": {
                      minWidth: isExpanded ? 38 : 0,
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
                  {isExpanded && <ListItemText primary={item.label} />}
                </ListItemButton>
              );

              return isDesktop && !desktopExpanded ? (
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
      <Stack alignItems={isExpanded ? "flex-start" : "center"} sx={{ p: 2 }}>
        {!isExpanded ? (
          <Tooltip title={`${currentName} - ${currentEmail}`} placement="right">
            <Avatar
              onClick={() => {
                if (isDesktop && !desktopExpanded) setDesktopExpanded(true);
                navigate("/settings");
              }}
              sx={{ width: 36, height: 36, bgcolor: "primary.main", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
            >
              {currentName.slice(0, 1).toUpperCase()}
            </Avatar>
          </Tooltip>
        ) : (
          <Stack
            direction="row"
            spacing={1.25}
            alignItems="center"
            onClick={() => navigate("/settings")}
            sx={{ cursor: "pointer", width: "100%", minWidth: 0 }}
          >
            <Avatar sx={{ width: 34, height: 34, bgcolor: "primary.main", fontSize: 13, fontWeight: 700 }}>
              {currentName.slice(0, 1).toUpperCase()}
            </Avatar>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>
                {currentName}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {currentEmail}
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
          ml: { md: `${activeDesktopWidth}px` },
          width: { md: `calc(100% - ${activeDesktopWidth}px)` },
          transition: theme.transitions.create(["margin-left", "width"], {
            duration: theme.transitions.duration.shorter
          }),
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
      <Box
        component="nav"
        sx={{
          width: { md: activeDesktopWidth },
          flexShrink: { md: 0 },
          transition: theme.transitions.create("width", { duration: theme.transitions.duration.shorter })
        }}
        aria-label="navegacion principal"
      >
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
              borderColor: "divider",
              transition: theme.transitions.create("width", { duration: theme.transitions.duration.shorter })
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
