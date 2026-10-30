// Runs before each test file imports app code.
process.env.NODE_ENV = "test";
process.env.RATE_LIMIT_ENABLED ??= "false";
process.env.CLIENT_URL = "http://localhost:5173";
process.env.ADMIN_URL = "http://127.0.0.1:5176";
// Fake Razorpay credentials: signatures are computed locally; the API client itself is mocked.
process.env.RAZORPAY_KEY_ID = "rzp_test_mock";
process.env.RAZORPAY_KEY_SECRET = "test_key_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "test_webhook_secret";
// No Cloudinary/SMTP: tests inject mock clients where needed, and check the "not configured" paths.
// Set to "" rather than deleted: dotenv (loaded by src/config/env.js) fills in missing variables from
// backend/.env, which would bring real credentials back; it never overrides variables that exist.
process.env.CLOUDINARY_CLOUD_NAME = "";
process.env.CLOUDINARY_API_KEY = "";
process.env.CLOUDINARY_API_SECRET = "";
process.env.SMTP_HOST = "";
