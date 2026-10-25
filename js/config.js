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

export const CURRENCY = "AED";
// 1 = weeks start Monday, 0 = Sunday, 6 = Saturday
export const WEEK_START = 1;
