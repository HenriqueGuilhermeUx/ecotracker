import { Platform } from "react-native";

export const colors = {
  background: "#06100C",
  backgroundRaised: "#091710",
  surface: "#0C1D14",
  surfaceStrong: "#11281B",
  surfaceSoft: "#102219",
  primary: "#69FF9A",
  primaryStrong: "#35E978",
  primaryMuted: "#173C27",
  blue: "#7BA7FF",
  amber: "#F5C66A",
  danger: "#FF7A74",
  text: "#F2FAF5",
  textMuted: "#91A99D",
  textDim: "#657D70",
  border: "#213B2D",
  borderStrong: "#315B40",
  black: "#030806",
  white: "#FFFFFF",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 44,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
};

export const typography = {
  hero: 38,
  title: 28,
  heading: 22,
  subheading: 18,
  body: 15,
  caption: 12,
  micro: 10,
};

export const shadow = Platform.select({
  ios: {
    shadowColor: "#000",
    shadowOpacity: 0.28,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
  },
  android: { elevation: 8 },
  default: {},
});
