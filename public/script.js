document.addEventListener('DOMContentLoaded', () => {
  const loginBtn = document.getElementById('login-btn');
  const sitePasswordInput = document.getElementById('site-password');
  const gateError = document.getElementById('gate-error');
  const passwordGate = document.getElementById('password-gate');
  const appContainer = document.getElementById('app-container');
  const logoutBtn = document.getElementById('logout-btn');

  const verifyBtn = document.getElementById('verify-btn');
  const smtpEmail = document.getElementById('smtp-email');
  const smtpPass = document.getElementById('smtp-pass');
  const senderName = document.getElementById('sender-name');
  const smtpStatus = document.getElementById('smtp-status');

  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const emailSubject = document.getElementById('email-subject');
  const emailBody = document.getElementById('email-body');
  const emailRecipients = document.getElementById('email-recipients');
  const logConsole = document.getElementById('log-console');

  loginBtn.addEventListener('click', async () => {
    const password = sitePasswordInput.value.trim();
    if (!password) return;

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();

      if (data.success) {
        passwordGate.classList.add('hidden');
        appContainer.classList.remove('hidden');
      } else {
        gateError.textContent = data.message || 'Invalid password';
      }
    } catch (e) {
      gateError.textContent = 'Auth request failed';
    }
  });

  logoutBtn.addEventListener('click', () => {
    appContainer.classList.add('hidden');
    passwordGate.classList.remove('hidden');
    sitePasswordInput.value = '';
  });

  verifyBtn.addEventListener('click', async () => {
    smtpStatus.textContent = 'Verifying connection...';
    smtpStatus.className = 'status-msg info';

    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: smtpEmail.value.trim(),
          appPassword: smtpPass.value.trim()
        })
      });
      const data = await res.json();

      if (data.success) {
        smtpStatus.textContent = 'SMTP connection verified successfully!';
        smtpStatus.className = 'status-msg success';
      } else {
        smtpStatus.textContent = data.message || 'Verification failed';
        smtpStatus.className = 'status-msg error';
      }
    } catch (e) {
      smtpStatus.textContent = 'Server verification request failed';
      smtpStatus.className = 'status-msg error';
    }
  });

  sendBtn.addEventListener('click', async () => {
    const recipientsRaw = emailRecipients.value.split('\n').filter(r => r.trim());
    if (recipientsRaw.length === 0) {
      alert('Please enter at least one recipient email.');
      return;
    }

    sendBtn.disabled = true;
    stopBtn.disabled = false;
    logConsole.innerHTML = '<div class="log-entry info">Starting dispatch process...</div>';

    try {
      const response = await fetch('/api/send-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: smtpEmail.value.trim(),
          appPassword: smtpPass.value.trim(),
          senderName: senderName.value.trim(),
          subject: emailSubject.value.trim(),
          messageBody: emailBody.value.trim(),
          recipients: recipientsRaw
        })
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const text = decoder.decode(value);
        const lines = text.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.replace('data: ', '').trim();
            if (jsonStr === '[DONE]') {
              const el = document.createElement('div');
              el.className = 'log-entry success';
              el.textContent = 'Dispatch completed!';
              logConsole.appendChild(el);
              sendBtn.disabled = false;
              stopBtn.disabled = true;
              return;
            }

            try {
              const log = JSON.parse(jsonStr);
              const el = document.createElement('div');
              if (log.success) {
                el.className = 'log-entry success';
                el.textContent = `[SUCCESS] Sent to ${log.recipient}`;
              } else {
                el.className = 'log-entry error';
                el.textContent = `[FAILED] ${log.recipient || 'Error'}: ${log.error}`;
              }
              logConsole.appendChild(el);
              logConsole.scrollTop = logConsole.scrollHeight;
            } catch (err) {}
          }
        }
      }
    } catch (err) {
      const el = document.createElement('div');
      el.className = 'log-entry error';
      el.textContent = `[ERROR] ${err.message}`;
      logConsole.appendChild(el);
    } finally {
      sendBtn.disabled = false;
      stopBtn.disabled = true;
    }
  });

  stopBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/stop', { method: 'POST' });
      const el = document.createElement('div');
      el.className = 'log-entry error';
      el.textContent = '[SYSTEM] Stop signal sent to server.';
      logConsole.appendChild(el);
    } catch (e) {}
  });
});
