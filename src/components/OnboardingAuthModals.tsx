import React, { useState } from 'react';
import { HardDrive, KeyRound, Lock, Server, ShieldCheck, X } from 'lucide-react';
import type { RemoteAuthInfo } from '../types';
import {
  invokeRpc,
  loginWithPassword,
  loginWithPin,
  probeRemoteServerAuth,
  resetPasswordWithCode,
  resetSharedEventSource,
  setConfiguredRemoteServerUrl,
  setStoredAuthToken,
  setupServerMasterAccount,
} from '../bridge';

interface ServerSetupModalProps {
  serverUrl?: string;
  onCompleted: () => void;
  onClose?: () => void;
}

export const ServerSetupModal: React.FC<ServerSetupModalProps> = ({
  serverUrl,
  onCompleted,
  onClose,
}) => {
  const [username, setUsername] = useState('admin');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [accessMode, setAccessMode] = useState<'local-accounts' | 'guest-lan'>('local-accounts');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim()) {
      setError('Username is required.');
      return;
    }
    if (password.length < 4) {
      setError('Password must be at least 4 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const res = await setupServerMasterAccount(
        {
          username: username.trim(),
          displayName: displayName.trim() || username.trim(),
          email: email.trim(),
          password,
          accessMode,
          allowGuestRoadie: accessMode === 'guest-lan',
        },
        serverUrl
      );
      if (!res.ok) {
        setError(res.error || 'Server setup failed.');
        return;
      }
      onCompleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="aqua-modal-backdrop" style={{ zIndex: 10020 }}>
      <div className="aqua-window" style={{ width: 470, maxWidth: '94vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="aqua-window-titlebar">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ShieldCheck size={14} /> Set Up Your RetroTunes Server
          </span>
          {onClose && (
            <button className="aqua-btn" onClick={onClose} style={{ padding: '1px 6px' }}>
              <X size={13} />
            </button>
          )}
        </div>
        <form onSubmit={handleSubmit} style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 11 }}>
          <div style={{ fontSize: 12, color: '#334155', lineHeight: 1.45 }}>
            Create the initial <strong>Label</strong> super-admin account for{' '}
            <code>{serverUrl || 'this server'}</code>.
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 4 }}>
                Username *
              </label>
              <input
                className="aqua-input"
                style={{ width: '100%' }}
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 4 }}>
                Display Name
              </label>
              <input
                className="aqua-input"
                style={{ width: '100%' }}
                placeholder="Studio Owner"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 4 }}>
              Email (Optional)
            </label>
            <input
              type="email"
              className="aqua-input"
              style={{ width: '100%' }}
              placeholder="owner@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 4 }}>
                Password *
              </label>
              <input
                type="password"
                className="aqua-input"
                style={{ width: '100%' }}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 4 }}>
                Confirm Password *
              </label>
              <input
                type="password"
                className="aqua-input"
                style={{ width: '100%' }}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
          </div>

          <div className="epod-capacity-card" style={{ padding: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>Default Household / LAN Access Policy:</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, marginBottom: 5, cursor: 'pointer' }}>
              <input
                type="radio"
                name="rtunes-access-mode"
                checked={accessMode === 'local-accounts'}
                onChange={() => setAccessMode('local-accounts')}
              />
              <span>Require Login (Private multi-user accounts)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, cursor: 'pointer' }}>
              <input
                type="radio"
                name="rtunes-access-mode"
                checked={accessMode === 'guest-lan'}
                onChange={() => setAccessMode('guest-lan')}
              />
              <span>Allow Guest LAN Roadie Playback (Read-only guests + admin login)</span>
            </label>
          </div>

          {error && <div style={{ fontSize: 11.5, color: '#b91c1c', fontWeight: 700 }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            {onClose && (
              <button type="button" className="aqua-btn" onClick={onClose}>
                Cancel
              </button>
            )}
            <button type="submit" className="aqua-btn primary" disabled={busy}>
              {busy ? 'Creating Label Account...' : 'Create Master Account & Enter'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface UnifiedAuthModalProps {
  serverUrl?: string;
  authInfo: RemoteAuthInfo | null;
  onUnlocked: () => void;
  onClose: () => void;
}

export const UnifiedAuthModal: React.FC<UnifiedAuthModalProps> = ({
  serverUrl,
  authInfo,
  onUnlocked,
  onClose,
}) => {
  const mode = authInfo?.authMode || 'local-pin';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [resetMode, setResetMode] = useState(false);
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await loginWithPassword(username.trim(), password, serverUrl);
      if (!res.ok) {
        setError(res.error || 'Invalid username or password.');
        return;
      }
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await resetPasswordWithCode(
        { username: username.trim(), code: resetCode.trim(), newPassword },
        serverUrl
      );
      if (!res.ok) {
        setError(res.error || 'Invalid or expired reset code.');
        return;
      }
      setResetMode(false);
      setResetCode('');
      setNewPassword('');
      setPassword('');
      setNotice('Password updated. Sign in with your new password.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await loginWithPin(pin, serverUrl);
      if (!res.ok) {
        setError(res.error || 'Invalid PIN.');
        return;
      }
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="aqua-modal-backdrop" style={{ zIndex: 10015 }} onClick={onClose}>
      <div className="aqua-window" style={{ width: 410, maxWidth: '92vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="aqua-window-titlebar">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Lock size={13} /> {authInfo?.serverName ? `Sign In — ${authInfo.serverName}` : 'Server Authentication Required'}
          </span>
          <button className="aqua-btn" onClick={onClose} style={{ padding: '1px 6px' }}>
            <X size={13} />
          </button>
        </div>

        {mode === 'local-accounts' && !resetMode && (
          <form onSubmit={handlePasswordLogin} style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 11 }}>
            <div style={{ fontSize: 12, color: '#334155' }}>
              Sign in with your RetroTunes account credentials.
            </div>
            <input
              className="aqua-input"
              autoFocus
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              type="password"
              className="aqua-input"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {notice && <div style={{ fontSize: 11.5, color: '#15803d', fontWeight: 600 }}>{notice}</div>}
            {error && <div style={{ fontSize: 11.5, color: '#b91c1c', fontWeight: 600 }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button
                type="button"
                className="aqua-btn"
                style={{ fontSize: 11 }}
                onClick={() => {
                  setResetMode(true);
                  setError(null);
                }}
              >
                <KeyRound size={12} /> Have a Reset Code?
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="aqua-btn"
                  onClick={() => {
                    setStoredAuthToken(null);
                    onClose();
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="aqua-btn primary" disabled={busy || !username.trim() || !password}>
                  {busy ? 'Signing In...' : 'Sign In'}
                </button>
              </div>
            </div>
          </form>
        )}

        {mode === 'local-accounts' && resetMode && (
          <form onSubmit={handleResetSubmit} style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 11 }}>
            <div style={{ fontSize: 12, color: '#334155' }}>
              Enter your username, admin-issued reset code, and a new password.
            </div>
            <input
              className="aqua-input"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              className="aqua-input"
              placeholder="One-Time Reset Code"
              value={resetCode}
              onChange={(e) => setResetCode(e.target.value)}
            />
            <input
              type="password"
              className="aqua-input"
              placeholder="New Password (min 4 chars)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            {error && <div style={{ fontSize: 11.5, color: '#b91c1c', fontWeight: 600 }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button type="button" className="aqua-btn" onClick={() => setResetMode(false)}>
                Back to Sign In
              </button>
              <button
                type="submit"
                className="aqua-btn primary"
                disabled={busy || !username.trim() || !resetCode.trim() || newPassword.length < 4}
              >
                {busy ? 'Resetting...' : 'Reset Password'}
              </button>
            </div>
          </form>
        )}

        {mode === 'local-pin' && (
          <form onSubmit={handlePinSubmit} style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 11 }}>
            <div style={{ fontSize: 12, color: '#334155' }}>
              Enter the rTunes server access PIN to unlock API and media streaming access.
            </div>
            <input
              type="password"
              className="aqua-input"
              autoFocus
              placeholder="Enter PIN..."
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
            {error && <div style={{ fontSize: 11.5, color: '#b91c1c', fontWeight: 600 }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="aqua-btn"
                onClick={() => {
                  setStoredAuthToken(null);
                  onClose();
                }}
              >
                Cancel
              </button>
              <button type="submit" className="aqua-btn primary" disabled={busy || !pin.trim()}>
                {busy ? 'Unlocking...' : 'Unlock'}
              </button>
            </div>
          </form>
        )}

        {mode === 'authentik' && (
          <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 12, color: '#334155' }}>
              This server uses <strong>Authentik SSO</strong> ({authInfo?.authentikIssuerUrl || 'OIDC'}).
            </div>
            {error && <div style={{ fontSize: 11.5, color: '#b91c1c', fontWeight: 600 }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="aqua-btn" onClick={onClose}>
                Cancel
              </button>
              {window.rtunesElectron?.invoke && (
                <button
                  type="button"
                  className="aqua-btn primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await invokeRpc('auth:login');
                      onUnlocked();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? 'Authenticating...' : 'Sign In with Authentik (PKCE)'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

interface ClientOnboardingModalProps {
  onSelectLocal: () => Promise<void>;
  onSelectRemote: (serverUrl: string, info: RemoteAuthInfo) => Promise<void>;
  onDismiss: () => void;
}

export const ClientOnboardingModal: React.FC<ClientOnboardingModalProps> = ({
  onSelectLocal,
  onSelectRemote,
  onDismiss,
}) => {
  const [step, setStep] = useState<'choice' | 'remote'>('choice');
  const [serverUrl, setServerUrl] = useState('http://192.168.1.10:3000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnectRemote = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = serverUrl.trim().replace(/\/+$/, '');
    if (!clean) {
      setError('Enter your rTunes-Server URL.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const info = window.rtunesElectron?.invoke
        ? await invokeRpc<{ ok: boolean; info?: RemoteAuthInfo; error?: string }>(
            'auth:probeRemoteServer',
            clean
          ).then((r) => {
            if (!r.ok || !r.info) throw new Error(r.error || 'Could not reach server');
            return r.info;
          })
        : await probeRemoteServerAuth(clean);
      setConfiguredRemoteServerUrl(clean);
      resetSharedEventSource();
      await onSelectRemote(clean, info);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="aqua-modal-backdrop" style={{ zIndex: 10010 }}>
      <div className="aqua-window" style={{ width: 540, maxWidth: '94vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="aqua-window-titlebar">
          <span>Welcome to RetroTunes (rTunes)</span>
          <button className="aqua-btn" onClick={onDismiss} style={{ padding: '1px 6px' }}>
            <X size={13} />
          </button>
        </div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {step === 'choice' ? (
            <>
              <div style={{ fontSize: 12.5, color: '#1e293b', lineHeight: 1.5 }}>
                Choose how this RetroTunes desktop client should source your media library:
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <button
                  type="button"
                  className="epod-capacity-card"
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    padding: 14,
                  }}
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onSelectLocal();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13 }}>
                    <HardDrive size={18} color="#2563eb" />
                    <span>Standalone Local Library</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: '#475569', lineHeight: 1.45 }}>
                    Index local folders or mounted NFS/SMB NAS shares directly and sync USB/MTP ePods.
                  </div>
                </button>

                <button
                  type="button"
                  className="epod-capacity-card"
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    padding: 14,
                  }}
                  onClick={() => setStep('remote')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13 }}>
                    <Server size={18} color="#16a34a" />
                    <span>Connect to an rTunes Server</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: '#475569', lineHeight: 1.45 }}>
                    Stream &amp; delta-sync your household music/video library from Docker or a host PC.
                  </div>
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={handleConnectRemote} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 12, color: '#334155' }}>
                Enter the URL of your RetroTunes Server to detect authentication and link this client:
              </div>
              <input
                className="aqua-input"
                autoFocus
                placeholder="http://192.168.1.10:3000 or https://rtunes.yourdomain.com"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
              />
              {error && <div style={{ fontSize: 11.5, color: '#b91c1c', fontWeight: 600 }}>{error}</div>}
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <button type="button" className="aqua-btn" onClick={() => setStep('choice')}>
                  Back
                </button>
                <button type="submit" className="aqua-btn primary" disabled={busy}>
                  {busy ? 'Connecting...' : 'Connect & Detect Server'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
