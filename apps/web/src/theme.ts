import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#136f63"
    },
    secondary: {
      main: "#2f5b9a"
    },
    background: {
      default: "#f6f8f7"
    }
  },
  shape: {
    borderRadius: 8
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h4: { fontWeight: 700 },
    h5: { fontWeight: 700 },
    button: { textTransform: "none", fontWeight: 700 }
  },
  components: {
    MuiCard: {
      defaultProps: { variant: "outlined" }
    },
    MuiTableCell: {
      styleOverrides: {
        head: { fontWeight: 700 }
      }
    }
  }
});
