import admin from "firebase-admin";


console.log('PROJECT_ID:', process.env.FIREBASE_PROJECT_ID);
console.log('CLIENT_EMAIL:', process.env.FIREBASE_CLIENT_EMAIL);
console.log('PRIVATE_KEY exists:', !!process.env.FIREBASE_PRIVATE_KEY);
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

export default admin;