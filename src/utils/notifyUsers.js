import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

export const sendEmail = async ({ to, subject, html, text }) => {
  try {
    console.log('📧 Attempting to send email to:', to);
    console.log('📧 Subject:', subject);
    console.log('🔑 Using email:', process.env.EMAIL_USER);

    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to,
      subject,
      html: html || text,
      text: text
    };

    const result = await transporter.sendMail(mailOptions);

    console.log('✅ Email sent successfully:', result.messageId);
    console.log('✅ Accepted recipients:', result.accepted);
    console.log('✅ Response:', result.response);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('❌ Email sending failed:');
    console.error('   Error Code:', error.code);
    console.error('   Error Message:', error.message);
    console.error('   Response Code:', error.responseCode);
    console.error('   Command:', error.command);
    console.error('   Full Error:', error);

    return { success: false, error: error.message };
  }
};

export const sendPasswordResetEmail = async (userEmail, token) => {
  const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;

  return await sendEmail({
    to: userEmail,
    subject: 'Password Reset Request',
    html: `<p>Click <a href="${resetLink}">here</a> to reset your password</p>`
  });
};

export const sendPasswordChangedNotification = async (email) => {
  return await sendEmail({
    to: email,
    subject: 'Password Changed Successfully',
    html: `
      <h2>Password Changed</h2>
      <p>Your password has been changed successfully.</p>
      <p>If you did not make this change, please contact support immediately.</p>
    `
  });
};