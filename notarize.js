const { notarize } = require('@electron/notarize');
const path = require('path');
const fs   = require('fs');

module.exports = async (context) => {
  const { appOutDir, packager } = context;

  if (packager.platform.name !== 'mac') return;

  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;

  console.log('[notarize] APPLE_API_KEY_ID:', APPLE_API_KEY_ID);
  console.log('[notarize] APPLE_API_ISSUER:', APPLE_API_ISSUER);
  console.log('[notarize] APPLE_API_KEY path:', APPLE_API_KEY);
  console.log('[notarize] APPLE_API_KEY file exists:', APPLE_API_KEY ? fs.existsSync(APPLE_API_KEY) : false);

  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
    console.warn('[notarize] skipping — APPLE_API_KEY, APPLE_API_KEY_ID, or APPLE_API_ISSUER not set');
    return;
  }

  if (!fs.existsSync(APPLE_API_KEY)) {
    throw new Error(`[notarize] key file not found at path: ${APPLE_API_KEY}`);
  }

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`[notarize] notarizing ${appPath}`);

  await notarize({
    appPath,
    appleApiKey:    APPLE_API_KEY,
    appleApiKeyId:  APPLE_API_KEY_ID,
    appleApiIssuer: APPLE_API_ISSUER,
  });

  console.log('[notarize] done');
};
