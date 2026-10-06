import { Dancing_Script } from "next/font/google";

/**
 * The script font a typed signature is shown in on screen. The signed PDF uses the same typeface
 * (src/lib/sign/pdf/fonts.ts), so what the person sees is what is written on the page. Latin letters
 * only; the page does not let other writing be typed as a signature (canTypeSignature).
 */
export const signatureFont = Dancing_Script({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-signature",
});

/** For an inline style: a portal (a sheet) sits outside the layout's element, so the variable would not reach it. */
export const signatureFontFamily = signatureFont.style.fontFamily;
