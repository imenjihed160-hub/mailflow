/**
 * MailFlow JS SDK  v2.0
 * Drop-in replacement for EmailJS — simpler, faster, free.
 *
 * Usage (HTML):
 *   <script src="https://your-backend.com/sdk.js"></script>
 *   MailFlow.init('pk_xxxxxxxx')
 *   await MailFlow.send({ template_id, to_email, params })
 *
 * Usage (npm):
 *   import MailFlow from 'mailflow-js'
 */

;(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory()
  } else if (typeof define === 'function' && define.amd) {
    define(factory)
  } else {
    global.MailFlow = factory()
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const VERSION = '2.0.0'
  let _publicKey = null
  let _apiBase   = null
  let _debug     = false
  let _retries   = 1

  // ── INIT ─────────────────────────────────────
  function init(publicKey, options = {}) {
    if (!publicKey || !publicKey.startsWith('pk_'))
      throw new Error('[MailFlow] Invalid public key. Must start with "pk_"')
    _publicKey = publicKey
    _apiBase   = (options.apiBase || _detectApiBase()).replace(/\/$/, '')
    _debug     = !!options.debug
    _retries   = options.retries ?? 1
    _log('Initialized', { key: publicKey, api: _apiBase })
  }

  function _detectApiBase() {
    // Try to use same origin if SDK was loaded from the backend
    if (typeof document !== 'undefined') {
      const scripts = document.querySelectorAll('script[src*="sdk.js"]')
      for (const s of scripts) {
        try {
          const url = new URL(s.src)
          return url.origin
        } catch {}
      }
    }
    return 'http://localhost:3001'
  }

  // ── SEND ─────────────────────────────────────
  /**
   * Send an email using a template
   * @param {Object} opts
   * @param {string} opts.template_id   Template ID from dashboard
   * @param {string} opts.to_email      Recipient email
   * @param {string} [opts.to_name]     Recipient name
   * @param {string} [opts.service_id]  SMTP service ID (uses first if omitted)
   * @param {string} [opts.reply_to]    Reply-to address
   * @param {Object} [opts.params]      Template variables
   * @returns {Promise<{ok, id, status, error?}>}
   */
  async function send(opts = {}) {
    _assertInit()
    const { template_id, service_id, to_email, to_name, params = {}, reply_to } = opts
    if (!template_id) throw new Error('[MailFlow] template_id is required')
    if (!to_email)    throw new Error('[MailFlow] to_email is required')

    _log('Sending to:', to_email, 'template:', template_id)

    const payload = { template_id, to_email, params }
    if (service_id) payload.service_id = service_id
    if (to_name)    payload.to_name    = to_name
    if (reply_to)   payload.reply_to   = reply_to

    let lastError
    for (let attempt = 0; attempt <= _retries; attempt++) {
      try {
        const res = await fetch(`${_apiBase}/v1/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Public-Key': _publicKey },
          body: JSON.stringify(payload)
        })
        const data = await res.json()
        if (!res.ok) {
          _log('Send failed:', data)
          return { ok: false, error: data.error || 'Send failed', status: res.status }
        }
        _log('Send success:', data)
        return data
      } catch (e) {
        lastError = e
        if (attempt < _retries) {
          _log(`Retry attempt ${attempt + 1}`)
          await _sleep(500 * (attempt + 1))
        }
      }
    }
    return { ok: false, error: lastError?.message || 'Network error' }
  }

  // ── SEND FORM ─────────────────────────────────
  /**
   * Shortcut: send from an HTML form element
   * @param {string}      templateId
   * @param {HTMLElement} formElement
   * @param {string}      toEmail
   * @param {Object}      [extra]  Extra params merged with form data
   */
  async function sendForm(templateId, formElement, toEmail, extra = {}) {
    _assertInit()
    if (!(formElement instanceof HTMLElement))
      throw new Error('[MailFlow] formElement must be a DOM element')
    const params = { ...Object.fromEntries(new FormData(formElement)), ...extra }
    return send({ template_id: templateId, to_email: toEmail, params })
  }

  // ── HELPERS ───────────────────────────────────
  function _assertInit() {
    if (!_publicKey) throw new Error('[MailFlow] Not initialized. Call MailFlow.init(publicKey) first.')
  }
  function _log(...args) { if (_debug) console.log('[MailFlow]', ...args) }
  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

  // ── PUBLIC API ────────────────────────────────
  return { init, send, sendForm, VERSION }
})
