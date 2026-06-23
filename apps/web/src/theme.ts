import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#4f46e5",
      dark: "#3730a3",
      light: "#818cf8",
      contrastText: "#ffffff"
    },
    secondary: {
      main: "#8b5cf6",
      dark: "#6d28d9",
      light: "#c4b5fd",
      contrastText: "#ffffff"
    },
    success: {
      main: "#22c55e"
    },
    warning: {
      main: "#f59e0b"
    },
    error: {
      main: "#ef4444"
    },
    background: {
      default: "#f6f7fb",
      paper: "#ffffff"
    },
    text: {
      primary: "#111217",
      secondary: "#8a8f9c"
    },
    divider: "#eaedf3"
  },
  shape: {
    borderRadius: 12
  },
  typography: {
    fontFamily: '"Plus Jakarta Sans", "Inter", "Segoe UI", "Roboto", "Helvetica", "Arial", sans-serif',
    fontSize: 13,
    h4: { fontSize: 30, fontWeight: 700, letterSpacing: -0.2, lineHeight: 1.2 },
    h5: { fontSize: 22, fontWeight: 700, letterSpacing: -0.1, lineHeight: 1.25 },
    h6: { fontSize: 17, fontWeight: 700, letterSpacing: 0, lineHeight: 1.3 },
    subtitle1: { fontSize: 14, fontWeight: 700 },
    body1: { fontSize: 14, lineHeight: 1.55 },
    body2: { fontSize: 13, lineHeight: 1.55 },
    caption: { fontSize: 11.5, lineHeight: 1.45 },
    button: { fontSize: 13, textTransform: "none", fontWeight: 700 }
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: "#f6f7fb",
          WebkitFontSmoothing: "antialiased",
          MozOsxFontSmoothing: "grayscale"
        }
      }
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          borderColor: "#eaedf3",
          boxShadow: "0 12px 32px rgba(16, 24, 40, 0.04)"
        }
      }
    },
    MuiCard: {
      defaultProps: { variant: "outlined" },
      styleOverrides: {
        root: {
          borderColor: "#eaedf3",
          boxShadow: "0 12px 32px rgba(16, 24, 40, 0.04)"
        }
      }
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          boxShadow: "none"
        },
        contained: {
          boxShadow: "0 10px 20px rgba(79, 70, 229, 0.18)"
        },
        outlined: {
          borderColor: "#e2e6ef"
        }
      }
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
          borderRadius: 999
        }
      }
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: 10
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
          borderRadius: 12,
          fontSize: 13
        },
        notchedOutline: {
          borderColor: "#dfe4ee"
        }
      }
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          fontSize: 13
        }
      }
    },
    MuiTableCell: {
      styleOverrides: {
        head: {
          color: "#8a8f9c",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.35,
          textTransform: "uppercase"
        },
        root: {
          borderColor: "#eef1f6",
          fontSize: 13
        }
      }
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 12
        }
      }
    },
    MuiAlert: {
      styleOverrides: {
        root: {
          borderRadius: 12,
          fontSize: 13
        }
      }
    }
  }
});
