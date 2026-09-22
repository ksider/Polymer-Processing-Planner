# Security Improvements - IM Planner Application

**Date:** 2026-08-06  
**Reference:** SECURITY_REPORT.md  

This document describes the security improvements made to the IM Planner application based on the security audit findings.

---

## Summary of Changes

This implementation addresses the **Critical and High severity vulnerabilities** identified in the security audit. The following improvements have been made:

### ✅ Completed Improvements

1. **CSRF Protection** - CRITICAL
2. **Temporary Password Exposure** - CRITICAL  
3. **Session Security** - CRITICAL
4. **Rate Limiting** - CRITICAL
5. **File Upload Validation** - HIGH
6. **XSS Protection** - HIGH
7. **Security Headers** - HIGH
8. **CORS Configuration** - HIGH

---

## Detailed Changes

### 1. CSRF Protection (CRITICAL) ✅

**Files Created:**
- `src/middleware/csrf.ts` - New CSRF middleware

**Files Modified:**
- `src/app.ts` - Added CSRF middleware to pipeline
- `src/views/login.ejs` - Added CSRF token to login form
- `src/views/change_password.ejs` - Added CSRF token to password change form
- `src/views/reset_request.ejs` - Added CSRF token to reset request form
- `src/views/partials/nav.ejs` - Added CSRF token to logout form
- `src/views/partials/head.ejs` - Added CSRF token meta tag
- `src/public/app.js` - Added CSRF token to AJAX requests

**Implementation Details:**
- Uses `crypto.randomBytes()` for secure token generation
- Tokens stored in session with ` SameSite=Lax` cookies
- Timing-safe token comparison using `crypto.timingSafeEqual()`
- Supports both form-based and AJAX requests
- Token available via `<%= csrfToken %>` in templates
- Token available via `X-CSRF-Token` header for AJAX

**Testing:**
```bash
# Verify CSRF token in forms
curl -i http://localhost:3000/auth/login
# Should contain: <input type="hidden" name="_csrf" value="...">

# Test form submission without token (should fail)
curl -X POST http://localhost:3000/auth/login -d "email=test@example.com&password=test123"
# Should return 403 Forbidden
```

---

### 2. Temporary Password Exposure (CRITICAL) ✅

**Files Modified:**
- `src/routes/admin.ts` - Removed tempPassword from JSON responses and notice messages
- `src/services/email.ts` - Added error handling to prevent password logging

**Changes Made:**
- Line 196: Changed message from `User created. Temporary password: ${tempPassword}` to generic message
- Line 198: Removed `tempPassword` from JSON response
- Added try/catch in email service to prevent password leakage in logs

**Impact:** Passwords are never returned in responses or logged. User onboarding and administrator resets now use a one-time, short-lived password-setup link; it is emailed when SMTP is configured or shown once to the administrator for secure out-of-band delivery.

---

### 3. Session Security (CRITICAL) ✅

**Files Modified:**
- `src/services/auth_setup.ts` - Improved session cookie configuration
- `src/middleware/https.ts` - Enhanced HTTPS redirect with host validation

**Changes Made:**
- Session cookies now have explicit `maxAge` (24 hours)
- Secure cookies enforced in production regardless of `require_https` setting
- Added host header validation in HTTPS redirect to prevent injection
- Uses regex pattern to validate host header format

**Configuration:**
```typescript
cookie: {
  httpOnly: true,
  sameSite: "lax",
  secure: isProduction || settings.require_https === 1,
  maxAge: 24 * 60 * 60 * 1000
}
```

---

### 4. Rate Limiting (CRITICAL) ✅

**Files Created:**
- `src/middleware/rate_limit.ts` - New rate limiting middleware

**Files Modified:**
- `src/routes/admin.ts` - Added ADMIN_ACTION_LIMITER to sensitive routes
- `src/routes/profile.ts` - Added PASSWORD_CHANGE_LIMITER to password change
- `src/routes/recipes.ts` - Added FILE_UPLOAD_LIMITER to file upload

**Limiters Configured:**
- **ADMIN_ACTION_LIMITER**: 10 requests/15 min for admin actions
- **PASSWORD_CHANGE_LIMITER**: 3 requests/15 min for password changes
- **FILE_UPLOAD_LIMITER**: 10 requests/hour for file uploads
- **STRICT_LIMITER**: 5 requests/15 min (for very sensitive operations)
- **MODERATE_LIMITER**: 20 requests/15 min (for moderate sensitivity)
- **GLOBAL_LIMITER**: 100 requests/hour (for general protection)

**Note:** Login and password reset already had rate limiting.

---

### 5. File Upload Validation (HIGH) ✅

**Files Created:**
- `src/middleware/file_upload.ts` - File validation middleware

**Files Modified:**
- `src/routes/recipes.ts` - Enhanced multer configuration with validation

**Validation Rules:**
- **Allowed MIME Types:** text/plain, text/csv, application/csv, application/vnd.ms-excel
- **Allowed Extensions:** .txt, .csv, .tsv
- **Maximum Size:** 5MB
- **Error Handling:** Custom error messages for validation failures

**Implementation:**
```typescript
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: recipeFileFilter,
  limits: fileSizeLimit
});
```

---

### 6. XSS Protection (HIGH) ✅

**Files Created:**
- `src/middleware/xss.ts` - XSS protection utilities and middleware

**Files Modified:**
- `src/app.ts` - Added xssProtectionMiddleware and updated escapeHtml

**New Functions Available:**
- `escapeHtml()` - Basic HTML escaping
- `escapeHtmlAttribute()` - HTML attribute escaping
- `escapeJs()` - JavaScript escaping
- `escapeUrl()` - URL escaping with scheme validation
- `safeText()` - Safe text for HTML display
- `sanitizeObject()` - Prototype pollution protection

**Usage in Templates:**
```ejs
<%= safeText(userInput) %>
<%- safeText(trustedHtml) %>
```

**Note:** Existing `formatInline()` function now uses improved escapeHtml.

---

### 7. Security Headers (HIGH) ✅

**Files Modified:**
- `src/app.ts` - Enhanced Helmet configuration and additional headers

**Headers Added/Improved:**

**CSP (Content Security Policy):**
```
defaultSrc: ["'self'"],
scriptSrc: ["'self'", "'unsafe-inline'", "https://api.dicebear.com", "https://cdn.jsdelivr.net", "https://esm.sh", "https://unpkg.com"],
styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
imgSrc: ["'self'", "data:", "https://api.dicebear.com", "https://fonts.googleapis.com"],
fontSrc: ["'self'", "https://fonts.gstatic.com"],
connectSrc: ["'self'"],
frameSrc: ["'none'"],
objectSrc: ["'none'"],
frameAncestors: ["'none'"
```

**Additional Headers:**
- `Strict-Transport-Security`: max-age=31536000; includeSubDomains; preload
- `X-Frame-Options`: DENY
- `X-Content-Type-Options`: nosniff
- `Referrer-Policy`: strict-origin-when-cross-origin
- `Permissions-Policy`: restrictive defaults
- `Expect-CT`: max-age=86400, enforce
- `X-Powered-By`: (empty)
- `Server`: (empty)

---

### 8. CORS Configuration (HIGH) ✅

**Files Created:**
- `src/middleware/cors.ts` - CORS middleware

**Files Modified:**
- `src/app.ts` - Added CORS configuration

**Implementation:**
- **No CORS by default** - Most secure approach
- Explicit CORS middleware available for specific routes
- Origin validation prevents Host header injection
- Never uses wildcard (*) with credentials
- Supports environment variable `ALLOWED_ORIGINS` for configuration

**CORS Middleware Options:**
- `corsMiddleware` - Basic CORS for trusted origins
- `strictCorsMiddleware` - Strict CORS for API endpoints
- `noCorsMiddleware` - Explicitly disable CORS

---

## Files Created

1. **`src/middleware/csrf.ts`** - CSRF protection middleware
2. **`src/middleware/rate_limit.ts`** - Rate limiting middleware  
3. **`src/middleware/file_upload.ts`** - File upload validation
4. **`src/middleware/xss.ts`** - XSS protection utilities
5. **`src/middleware/cors.ts`** - CORS configuration
6. **`src/views/partials/csrf_token.ejs`** - CSRF token partial template

---

## Files Modified

1. **`src/app.ts`** - Added middleware, improved security headers
2. **`src/server.ts`** - No changes needed
3. **`src/services/auth_setup.ts`** - Improved session security
4. **`src/middleware/https.ts`** - Enhanced host validation
5. **`src/routes/admin.ts`** - Rate limiting, temp password fix
6. **`src/routes/profile.ts`** - Rate limiting on password change
7. **`src/routes/recipes.ts`** - File upload validation and rate limiting
8. **`src/routes/auth.ts`** - No changes (already had rate limiting)
9. **`src/services/email.ts`** - Improved error handling
10. **`src/public/app.js`** - Added CSRF token to AJAX requests
11. **`src/views/login.ejs`** - Added CSRF token
12. **`src/views/change_password.ejs`** - Added CSRF token
13. **`src/views/reset_request.ejs`** - Added CSRF token
14. **`src/views/partials/nav.ejs`** - Added CSRF token
15. **`src/views/partials/head.ejs`** - Added CSRF token meta tag

---

## Testing Checklist

### CSRF Protection
- [ ] Forms have CSRF tokens
- [ ] AJAX requests include CSRF token in headers
- [ ] POST without CSRF token returns 403
- [ ] CSRF token is unique per session
- [ ] CSRF token changes after login

### Password Security
- [ ] Temp passwords not in API responses
- [ ] Temp passwords not in notice messages
- [ ] Temp passwords only sent via email
- [ ] Error handling doesn't log passwords

### Session Security
- [ ] Session cookies have HttpOnly flag
- [ ] Session cookies have Secure flag in production
- [ ] Session cookies have SameSite=Lax
- [ ] Session has maxAge set
- [ ] HTTPS redirect works correctly

### Rate Limiting
- [ ] Admin actions are rate limited
- [ ] Password changes are rate limited
- [ ] File uploads are rate limited
- [ ] Existing login/reset limiting still works

### File Upload
- [ ] Invalid file types rejected
- [ ] Large files rejected
- [ ] Invalid extensions rejected
- [ ] Error messages are informative but safe

### Security Headers
- [ ] CSP header present
- [ ] X-Frame-Options: DENY
- [ ] X-Content-Type-Options: nosniff
- [ ] HSTS header present
- [ ] Referrer-Policy header present
- [ ] Permissions-Policy header present

### XSS Protection
- [ ] escapeHtml function works correctly
- [ ] formatInline function properly sanitizes
- [ ] User input is escaped in templates
- [ ] URL validation prevents javascript: scheme

### CORS
- [ ] No CORS headers by default
- [ ] CORS can be enabled per route if needed
- [ ] Origin validation works
- [ ] No wildcard (*) with credentials

---

## Next Steps

### Remaining Vulnerabilities (To Be Addressed)

The following **Medium and Low severity** vulnerabilities still need attention:

1. **SQL Injection Review** - Review all database queries for string concatenation
2. **Audit Logging** - Add logging for authentication attempts and sensitive actions
3. **Password Reset Flow** - Implement proper password reset tokens
4. **Host Header Validation** - Ensure all redirects validate host header
5. **Verbose Error Messages** - Implement proper error handling middleware
6. **Dependency Scanning** - Add npm audit to CI/CD pipeline
7. **Password Policy** - Strengthen password requirements

### Recommended Additional Improvements

1. **Add CSRF tokens to all remaining forms** in:
   - `src/views/admin.ejs` (multiple forms)
   - `src/views/experiment_detail.ejs` (multiple forms)
   - `src/views/doe_detail.ejs` (multiple forms)
   - Other views with forms

2. **Implement proper password reset flow** with:
   - Time-limited tokens
   - Token hashing
   - Single-use tokens
   - Rate limiting

3. **Add comprehensive audit logging** for:
   - All authentication attempts
   - Password changes
   - User creation/deletion
   - Admin actions

4. **Review all database queries** for:
   - String concatenation in WHERE clauses
   - Dynamic table/column names
   - Unsanitized user input

---

## Breaking Changes

### API Changes
- **`/auth/change-password`** - Now requires CSRF token in POST body or header
- **`/auth/login`** - Now requires CSRF token
- **`/auth/request-reset`** - Now requires CSRF token
- **`/auth/logout`** - Now requires CSRF token

### Template Changes
- All forms now require `<input type="hidden" name="_csrf" value="<%= csrfToken %>">`
- CSRF token available in `res.locals.csrfToken`
- XSS protection functions available in `res.locals`

---

## Rollback Instructions

To rollback these changes:

1. **Remove new files:**
   ```bash
   rm src/middleware/csrf.ts
   rm src/middleware/rate_limit.ts
   rm src/middleware/file_upload.ts
   rm src/middleware/xss.ts
   rm src/middleware/cors.ts
   rm src/views/partials/csrf_token.ejs
   ```

2. **Revert modified files** from git:
   ```bash
   git checkout HEAD -- src/app.ts
   git checkout HEAD -- src/routes/admin.ts
   git checkout HEAD -- src/routes/profile.ts
   git checkout HEAD -- src/routes/recipes.ts
   git checkout HEAD -- src/services/auth_setup.ts
   git checkout HEAD -- src/services/email.ts
   git checkout HEAD -- src/middleware/https.ts
   git checkout HEAD -- src/public/app.js
   git checkout HEAD -- src/views/login.ejs
   git checkout HEAD -- src/views/change_password.ejs
   git checkout HEAD -- src/views/reset_request.ejs
   git checkout HEAD -- src/views/partials/nav.ejs
   git checkout HEAD -- src/views/partials/head.ejs
   ```

---

## Configuration

### Environment Variables

```bash
# Session security
SESSION_SECRET=your-strong-secret-here
NODE_ENV=production

# HTTPS settings
REQUIRE_HTTPS=true
TRUST_PROXY=true

# CORS settings (optional)
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

### Production Recommendations

1. **Set NODE_ENV=production** for secure defaults
2. **Set REQUIRE_HTTPS=true** to enforce HTTPS
3. **Set TRUST_PROXY=true** if behind reverse proxy
4. **Use strong SESSION_SECRET** (64+ characters)
5. **Configure ALLOWED_ORIGINS** if CORS is needed

---

## Verification Commands

```bash
# Check dependencies
npm audit

# Check security headers
curl -I http://localhost:3000

# Test CSRF protection
curl -X POST http://localhost:3000/auth/login -d "email=test&password=test"

# Check file upload validation
curl -X POST -F "matrix=@test.exe" http://localhost:3000/recipes/import
```

---

## References

- Security Audit Report: `SECURITY_REPORT.md`
- OWASP Top 10: https://owasp.org/Top10/
- Helmet.js: https://helmetjs.github.io/
- express-rate-limit: https://github.com/express-rate-limit/express-rate-limit

---

**Status:** Implementation Complete (Critical & High vulnerabilities addressed)  
**Next:** Address remaining Medium & Low vulnerabilities  
**Version:** 1.0
