// generate-flyer.js — generates a PDF welcome flyer for a unit slot
// Uses pdf-lib (npm install pdf-lib)
// Returns base64 PDF or sends it via email

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { send } = require('./send-email');

const SITE = process.env.SITE_URL || 'https://myspotparking.com';

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return rgb(r, g, b);
}

async function buildFlyer({ propertyName, propertyAddress, unitNumber, inviteCode, slotLabel, slotType }) {
  const signupUrl = `${SITE}/signup.html?invite=${inviteCode}`;

  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter
  const { width, height } = page.getSize();

  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const regularFont = await doc.embedFont(StandardFonts.Helvetica);

  const blue = hexToRgb('#1a6fff');
  const darkText = hexToRgb('#0f172a');
  const grayText = hexToRgb('#64748b');
  const lightBg = hexToRgb('#f4f7ff');
  const white = rgb(1, 1, 1);

  // ── Header band ──────────────────────────────────────────
  page.drawRectangle({ x: 0, y: height - 120, width, height: 120, color: blue });

  page.drawText('🅿', { x: 48, y: height - 72, size: 36, font: boldFont, color: white });
  page.drawText('My Spot Parking', { x: 96, y: height - 56, size: 22, font: boldFont, color: white });
  page.drawText('Resident Parking Permit Setup', { x: 96, y: height - 80, size: 12, font: regularFont, color: rgb(0.8, 0.88, 1) });

  // ── Welcome text ─────────────────────────────────────────
  page.drawText('Welcome to your new home!', { x: 48, y: height - 160, size: 20, font: boldFont, color: darkText });
  page.drawText('Use the instructions below to set up your parking permit online.', {
    x: 48, y: height - 184, size: 11, font: regularFont, color: grayText,
  });

  // ── Property info box ────────────────────────────────────
  page.drawRectangle({ x: 48, y: height - 300, width: width - 96, height: 96, color: lightBg, borderRadius: 8 });
  page.drawText('PROPERTY', { x: 64, y: height - 228, size: 9, font: boldFont, color: grayText });
  page.drawText(propertyName, { x: 64, y: height - 244, size: 14, font: boldFont, color: darkText });
  if (propertyAddress) {
    page.drawText(propertyAddress, { x: 64, y: height - 262, size: 10, font: regularFont, color: grayText });
  }
  page.drawText('YOUR UNIT', { x: 340, y: height - 228, size: 9, font: boldFont, color: grayText });
  page.drawText(`Unit ${unitNumber}`, { x: 340, y: height - 244, size: 20, font: boldFont, color: blue });
  if (slotLabel) {
    page.drawText(slotLabel, { x: 340, y: height - 264, size: 10, font: regularFont, color: grayText });
  }

  // ── Steps ────────────────────────────────────────────────
  const steps = [
    { num: '1', title: 'Visit the signup page', detail: signupUrl },
    { num: '2', title: 'Enter your invite code', detail: inviteCode },
    { num: '3', title: 'Fill in your info and pay', detail: 'Monthly, quarterly, or yearly billing available' },
    { num: '4', title: 'Check your email', detail: 'You\'ll receive your login credentials instantly' },
    { num: '5', title: 'Log in and add your vehicle', detail: `${SITE}/holder.html` },
  ];

  let y = height - 340;
  page.drawText('HOW TO GET STARTED', { x: 48, y, size: 10, font: boldFont, color: grayText });
  y -= 24;

  for (const step of steps) {
    // Circle
    page.drawCircle({ x: 64, y: y + 6, size: 13, color: blue });
    page.drawText(step.num, { x: step.num === '1' ? 60 : 59, y: y, size: 10, font: boldFont, color: white });
    page.drawText(step.title, { x: 88, y: y + 4, size: 12, font: boldFont, color: darkText });
    page.drawText(step.detail, { x: 88, y: y - 12, size: 10, font: regularFont, color: grayText });
    y -= 52;
  }

  // ── Invite code callout ──────────────────────────────────
  y -= 8;
  page.drawRectangle({ x: 48, y: y - 20, width: width - 96, height: 72, color: blue, borderRadius: 8 });
  page.drawText('YOUR INVITE CODE', { x: 64, y: y + 32, size: 9, font: boldFont, color: rgb(0.7, 0.85, 1) });
  page.drawText(inviteCode, { x: 64, y: y + 10, size: 28, font: boldFont, color: white });
  page.drawText('Enter this code at the signup page to get started', {
    x: 64, y: y - 8, size: 10, font: regularFont, color: rgb(0.8, 0.9, 1),
  });

  // ── QR code placeholder note ─────────────────────────────
  // Note: full QR code rendering requires a QR library;
  // the signup URL is printed clearly as a fallback
  y -= 60;
  page.drawText('Or visit:', { x: 48, y, size: 10, font: regularFont, color: grayText });
  page.drawText(signupUrl, { x: 48, y: y - 16, size: 11, font: boldFont, color: blue });

  // ── Footer ───────────────────────────────────────────────
  page.drawLine({ start: { x: 48, y: 64 }, end: { x: width - 48, y: 64 }, thickness: 1, color: hexToRgb('#e2e8f0') });
  page.drawText(`© ${new Date().getFullYear()} My Spot Parking Inc. · myspotparking.com`, {
    x: 48, y: 44, size: 9, font: regularFont, color: grayText,
  });
  page.drawText('Questions? Contact your property manager.', {
    x: 48, y: 28, size: 9, font: regularFont, color: grayText,
  });

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const { propertyName, propertyAddress, unitNumber, inviteCode, slotLabel, slotType, emailTo, action } = body;

    if (!propertyName || !unitNumber || !inviteCode) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const pdfBuffer = await buildFlyer({ propertyName, propertyAddress, unitNumber, inviteCode, slotLabel, slotType });
    const pdfBase64 = pdfBuffer.toString('base64');

    // If emailTo provided, send the flyer as an email attachment note
    // (SES doesn't support attachments easily — we include the signup URL prominently instead)
    if (action === 'email' && emailTo) {
      const signupUrl = `${SITE}/signup.html?invite=${inviteCode}`;
      const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
      const ses = new SESClient({
        region: process.env.AWS_SES_REGION || 'us-east-1',
        credentials: {
          accessKeyId: process.env.AWS_SES_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SES_SECRET_ACCESS_KEY,
        },
      });
      await ses.send(new SendEmailCommand({
        Source: `My Spot Parking <${process.env.AWS_SES_FROM_EMAIL || 'noreply@myspotparking.com'}>`,
        Destination: { ToAddresses: [emailTo] },
        Message: {
          Subject: { Data: `Your parking permit invite — ${propertyName} Unit ${unitNumber}` },
          Body: {
            Html: {
              Data: `
<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;">
  <div style="background:#1a6fff;border-radius:12px;padding:24px;text-align:center;margin-bottom:32px;">
    <div style="color:#fff;font-size:20px;font-weight:700;">🅿 My Spot Parking</div>
  </div>
  <h2>Set up your parking permit</h2>
  <p style="color:#475569;">You have been invited to set up a parking permit for <strong>${propertyName}</strong> — Unit <strong>${unitNumber}</strong>.</p>
  <div style="background:#f4f7ff;border-radius:10px;padding:20px;margin:24px 0;text-align:center;">
    <div style="font-size:12px;color:#64748b;margin-bottom:8px;">YOUR INVITE CODE</div>
    <div style="font-size:32px;font-weight:700;font-family:monospace;letter-spacing:4px;color:#1a6fff;">${inviteCode}</div>
  </div>
  <a href="${signupUrl}" style="display:block;background:#1a6fff;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:600;font-size:15px;margin-bottom:16px;">Set Up My Permit →</a>
  <p style="color:#94a3b8;font-size:12px;text-align:center;">Or visit: ${signupUrl}</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} My Spot Parking Inc.</p>
</body></html>`,
            },
            Text: { Data: `Set up your parking permit for ${propertyName} Unit ${unitNumber}.\n\nInvite code: ${inviteCode}\n\nVisit: ${signupUrl}` },
          },
        },
      }));
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, pdf: pdfBase64 }),
    };

  } catch (err) {
    console.error('generate-flyer error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
