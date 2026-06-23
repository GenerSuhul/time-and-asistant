import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#0f766e",
      dark: "#0b5f59",
      light: "#14b8a6",
      contrastText: "#ffffff"
    },
    secondary: {
      main: "#4f46e5",
      dark: "#3730a3",
      light: "#818cf8",
      contrastText: "#ffffff"
    },
    success: {
      main: "#16a34a"
    },
    warning: {
      main: "#f59e0b"
    },
    error: {
      main: "#dc2626"
    },
    background: {
      default: "#f4f7f8",
      paper: "#ffffff"
    },
    text: {
      primary: "#111827",
      secondary: "#6b7280"
    },
    divider: "#e5e7eb"
  },
  shape: {
    borderRadius: 8
  },
  typography: {
    fontFamily: '"Inter", "Segoe UI", "Roboto", "Helvetica", "Arial", sans-serif',
    h4: { fontWeight: 800, letterSpacing: 0 },
    h5: { fontWeight: 800, letterSpacing: 0 },
    h6: { fontWeight: 800, letterSpacing: 0 },
    subtitle1: { fontWeight: 700 },
    button: { textTransform: "none", fontWeight: 800 },
    body2: { lineHeight: 1.55 }
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: "#f4f7f8"
        }
      }
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          borderColor: "#e5e7eb"
        }
      }
    },
    MuiCard: {
      defaultProps: { variant: "outlined" },
      styleOverrides: {
        root: {
          borderColor: "#e5e7eb",
          boxShadow: "0 1px 2px rgba(15, 23, 42, 0.05)"
        }
      }
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8
        },
        contained: {
          boxShadow: "0 10px 18px rgba(15, 118, 110, 0.18)"
        }
      }
    },
    MuiTextField: {
      defaultProps: {
        variant: "outlined"
      }
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: "#ffffff",
          borderRadius: 8
        },
        notchedOutline: {
          borderColor: "#d8dee6"
        }
      }
    },
    MuiTableCell: {
      styleOverrides: {
        head: {
          color: "#4b5563",
          fontSize: 12,
          fontWeight: 800,
          letterSpacing: 0.4,
          textTransform: "uppercase"
        },
        root: {
          borderColor: "#eef2f7"
        }
      }
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 8
        }
      }
    }
  }
});
