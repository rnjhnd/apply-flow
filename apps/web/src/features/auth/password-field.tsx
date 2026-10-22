import { useState, type Ref } from 'react';
import { Button } from '../../components/ui/button';

export const fieldClass = 'min-h-11 w-full min-w-0 rounded-md border border-input bg-surface px-3 py-2 text-base text-foreground outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60';

export function PasswordField({ mode, inputRef, error }: {
  mode: 'login' | 'register'; inputRef: Ref<HTMLInputElement>; error?: string | undefined;
}) {
  const [visible, setVisible] = useState(false);
  return <div className="space-y-2">
    <label htmlFor="password" className="block text-sm font-semibold">Password</label>
    <input ref={inputRef} id="password" name="password" type={visible ? 'text' : 'password'} required
      autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
      autoCapitalize="none" spellCheck={false} aria-invalid={error ? true : undefined}
      aria-describedby={[mode === 'register' ? 'password-hint' : '', error ? 'password-error' : ''].filter(Boolean).join(' ') || undefined}
      className={fieldClass} />
    <Button variant="outline" aria-controls="password" aria-pressed={visible} onClick={() => setVisible(!visible)}>
      {visible ? 'Hide password' : 'Show password'}
    </Button>
    {mode === 'register' && <p id="password-hint" className="text-sm leading-6 text-muted-foreground">Use 15–128 characters. Spaces are welcome. You can paste a password or use your password manager.</p>}
    {error && <p id="password-error" className="text-sm font-medium">{error}</p>}
  </div>;
}
