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
  ListSubheader,
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
import CloudDoneIcon from "@mui/icons-material/CloudDone";
import { NavLink, useNavigate } from "react-router-dom";
import { useSession } from "../hooks/useSession";
import { supabase } from "../lib/supabase";

const drawerWidth = 272;

const navSections = [
  {
    label: "Operacion",
    items: [
      { label: "Dashboard", to: "/", icon: <DashboardIcon /> },
      { label: "Empresas", to: "/companies", icon: <ApartmentIcon /> },
      { label: "Sucursales", to: "/branches", icon: <ApartmentIcon /> },
      { label: "Departamentos", to: "/departments", icon: <GroupsIcon /> },
      { label: "Grupos asistencia", to: "/attendance-groups", icon: <FactCheckIcon /> },
      { label: "Horarios", to: "/work-schedules", icon: <EventIcon /> }
    ]
  },
  {
    label: "Acceso",
    items: [
      { label: "Empleados", to: "/employees", icon: <BadgeIcon /> },
      { label: "Dispositivos", to: "/devices", icon: <DevicesIcon /> },
      { label: "Asignaciones", to: "/employee-devices", icon: <GroupsIcon /> },
      { label: "Comandos", to: "/commands", icon: <TuneIcon /> },
      { label: "Eventos en vivo", to: "/live-events", icon: <HistoryIcon /> }
    ]
  },
  {
    label: "Reportes",
    items: [
      { label: "Reporte diario", to: "/daily-report", icon: <FactCheckIcon /> },
      { label: "Reporte rango", to: "/range-report", icon: <FactCheckIcon /> },
      { label: "Ajustes manuales", to: "/manual-adjustments", icon: <TuneIcon /> },
      { label: "Auditoria", to: "/audit", icon: <HistoryIcon /> },
      { label: "Configuracion", to: "/settings", icon: <SettingsIcon /> }
    ]
  }
];

export function AppLayout({ children }: PropsWithChildren) {
  const navigate = useNavigate();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { session } = useSession();

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

  const drawer = (
    <Box sx={{ display: "flex", minHeight: "100%", flexDirection: "column", bgcolor: "#ffffff" }}>
      <Stack spacing={1.5} sx={{ p: 2.25, pb: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1.25}>
          <Box
            sx={{
              width: 38,
              height: 38,
              borderRadius: 2,
              display: "grid",
              placeItems: "center",
              color: "white",
              fontWeight: 900,
              background: "linear-gradient(135deg, #0f766e 0%, #4f46e5 100%)",
              boxShadow: "0 12px 22px rgba(15, 118, 110, 0.20)"
            }}
          >
            AC
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ lineHeight: 1.15 }}>
              Renovagt
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Control de asistencia
            </Typography>
          </Box>
        </Stack>
        <Chip
          size="small"
          icon={<CloudDoneIcon />}
          label="Ambiente produccion"
          sx={{
            alignSelf: "flex-start",
            bgcolor: alpha(theme.palette.primary.main, 0.09),
            color: "primary.dark",
            border: `1px solid ${alpha(theme.palette.primary.main, 0.20)}`
          }}
        />
      </Stack>
      <Divider />
      <Box sx={{ flex: 1, overflowY: "auto", py: 1 }}>
        {navSections.map((section) => (
          <List
            key={section.label}
            dense
            subheader={
              <ListSubheader
                sx={{
                  bgcolor: "transparent",
                  color: "text.secondary",
                  fontSize: 11,
                  fontWeight: 900,
                  letterSpacing: 0.7,
                  lineHeight: "32px",
                  textTransform: "uppercase"
                }}
              >
                {section.label}
              </ListSubheader>
            }
          >
            {section.items.map((item) => (
              <ListItemButton
                key={item.to}
                component={NavLink}
                to={item.to}
                end={item.to === "/"}
                onClick={() => setMobileOpen(false)}
                sx={{
                  mx: 1.25,
                  my: 0.2,
                  minHeight: 42,
                  color: "text.secondary",
                  "& .MuiListItemIcon-root": {
                    minWidth: 38,
                    color: "inherit"
                  },
                  "& .MuiListItemText-primary": {
                    fontSize: 14,
                    fontWeight: 700
                  },
                  "&:hover": {
                    bgcolor: alpha(theme.palette.primary.main, 0.07),
                    color: "primary.dark"
                  },
                  "&.active": {
                    bgcolor: "primary.main",
                    color: "primary.contrastText",
                    boxShadow: "0 10px 18px rgba(15, 118, 110, 0.18)",
                    "& .MuiListItemIcon-root": { color: "inherit" }
                  }
                }}
              >
                <ListItemIcon>{item.icon}</ListItemIcon>
                <ListItemText primary={item.label} />
              </ListItemButton>
            ))}
          </List>
        ))}
      </Box>
      <Divider />
      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ p: 2 }}>
        <Avatar sx={{ width: 34, height: 34, bgcolor: "secondary.main", fontSize: 14 }}>
          {(session?.user.email ?? "U").slice(0, 1).toUpperCase()}
        </Avatar>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: 800 }} noWrap>
            Administrador
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {session?.user.email ?? "Sesion activa"}
          </Typography>
        </Box>
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
          ml: { md: `${drawerWidth}px` },
          width: { md: `calc(100% - ${drawerWidth}px)` },
          zIndex: theme.zIndex.drawer + 1
        }}
      >
        <Toolbar sx={{ gap: 1.5, minHeight: { xs: 64, sm: 72 } }}>
          {!isDesktop && (
            <IconButton onClick={() => setMobileOpen(true)} aria-label="abrir menu">
              <MenuIcon />
            </IconButton>
          )}
          <Box component="form" onSubmit={submitSearch} sx={{ display: { xs: "none", sm: "block" }, maxWidth: 430, flex: 1 }}>
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
            <Chip size="small" label="Produccion" color="success" variant="outlined" sx={{ display: { xs: "none", md: "inline-flex" } }} />
            <Tooltip title="Cerrar sesion">
              <Button color="inherit" startIcon={<LogoutIcon />} onClick={signOut}>
                Salir
              </Button>
            </Tooltip>
          </Stack>
        </Toolbar>
      </AppBar>
      <Box component="nav" sx={{ width: { md: drawerWidth }, flexShrink: { md: 0 } }} aria-label="navegacion principal">
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
      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, p: { xs: 2, lg: 3 } }}>
        <Toolbar sx={{ minHeight: { xs: 64, sm: 72 } }} />
        {children}
      </Box>
    </Box>
  );
}
