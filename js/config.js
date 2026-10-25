// Firebase web config for the "expense" project.
// Firebase console → Project settings → General → Your apps → Web app (</>) → SDK setup and configuration → Config.
// Paste the values below, commit, and the app connects.
export const firebaseConfig = {
  apiKey: "AIzaSyDW1mQMw0LOxMf-HSBgxXEXvu-Wfl9MKjE",
  authDomain: "expense-4a374.firebaseapp.com",
  projectId: "expense-4a374",
  storageBucket: "expense-4a374.firebasestorage.app",
  messagingSenderId: "90055874709",
  appId: "1:90055874709:web:9ac9613982b9b4756da39c"
};

// This email becomes the first admin automatically on first sign-in.
// Must match the email in firestore.rules (function isSuper).
export const SUPER_ADMIN_EMAIL = "anwar@llct.net";

// Default currency for new accounts (each account can change it in Account heads → Account settings)
export const DEFAULT_CURRENCY = "INR";
// 1 = weeks start Monday, 0 = Sunday, 6 = Saturday
export const WEEK_START = 1;

// App Check (reCAPTCHA Enterprise key from Google Cloud → Security → Fraud Defense)
export const RECAPTCHA_KEY = "6LdDhQAuAAAAAF3SKeah_Exi_lfrgj0-pUOpU6Zz";
// Gemini models for reading bills, tried in order
export const AI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash"];
