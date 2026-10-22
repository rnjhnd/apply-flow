import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { loginRequestSchema, registerRequestSchema, type LoginRequest } from '@applyflow/contracts';
import { Button } from '../../components/ui/button';
import { useAuthAdmission } from './auth-admission';
import { PasswordField, fieldClass } from './password-field';

export function AuthForm({ mode, submit, registrationEnabled, remoteFields = [] }: {
  mode: 'login' | 'register';
  submit: (input: LoginRequest, canSubmit: () => boolean) => boolean;
  registrationEnabled: boolean;
  remoteFields?: readonly ('email' | 'password')[];
}) {
  const admission = useAuthAdmission();
  const password = useRef<HTMLInputElement>(null);
  const summary = useRef<HTMLParagraphElement>(null);
  const [errors, setErrors] = useState<{ email?: string; password?: string } | null>(null);
  const emailError = errors?.email ?? (remoteFields.includes('email') ? 'Review your email address.' : undefined);
  const passwordError = errors?.password ?? (remoteFields.includes('password') ? 'Review your password.' : undefined);
  useLayoutEffect(() => {
    const field = password.current;
    return () => { if (field) field.value = ''; };
  }, []);

  return <section className="space-y-7">
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Your next chapter</p>
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">{mode === 'login' ? 'Sign in' : 'Create an account'}</h1>
      <p className="text-sm leading-6 text-muted-foreground">{mode === 'login'
        ? 'A little clarity for the journey ahead. Sign in to your ApplyFlow workspace.'
        : 'Make room for a more focused job search. Start with your email and a strong password.'}</p>
    </div>
    <form method="post" noValidate aria-label={mode === 'login' ? 'Sign in' : 'Create an account'} className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!admission.canSubmit()) return;
        const data = new FormData(event.currentTarget);
        const parsed = (mode === 'login' ? loginRequestSchema : registerRequestSchema).safeParse({ email: data.get('email'), password: data.get('password') });
        if (!parsed.success) {
          const fields = parsed.error.issues.map((issue) => issue.path[0]);
          setErrors({ ...(fields.includes('email') ? { email: 'Enter a valid email address.' } : {}),
            ...(fields.includes('password') ? { password: mode === 'register' ? 'Use 15–128 characters for your password.' : 'Enter your password (up to 128 characters).' } : {}) });
          // Focus the summary only after a deliberate invalid submission, never background checks.
          queueMicrotask(() => { if (summary.current?.isConnected) summary.current.focus(); });
          return;
        }
        setErrors(null);
        if (submit(parsed.data, admission.canSubmit) && password.current) password.current.value = '';
      }}>
      {errors && <p ref={summary} tabIndex={-1} role="alert" className="rounded-md border border-primary p-3 text-sm outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Please review the fields below. Your request has not been sent.</p>}
      <div className="space-y-2">
        <label htmlFor="email" className="block text-sm font-semibold">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} required
          aria-invalid={emailError ? true : undefined} aria-describedby={emailError ? 'email-error' : undefined} className={fieldClass} />
        {emailError && <p id="email-error" className="text-sm font-medium">{emailError}</p>}
      </div>
      <PasswordField mode={mode} inputRef={password} error={passwordError} />
      <Button type="submit" disabled={!admission.allowed} className="w-full sm:w-auto">{mode === 'login' ? 'Sign in' : 'Create account'}</Button>
    </form>
    <p className="text-sm leading-6 text-muted-foreground">{mode === 'register'
      ? <>Already have an account? <Link to="/login" className="font-semibold text-primary underline underline-offset-4">Sign in</Link></>
      : registrationEnabled ? <>New to ApplyFlow? <Link to="/register" className="font-semibold text-primary underline underline-offset-4">Create an account</Link></> : 'Account creation is not enabled here.'}</p>
    <Link to="/" className="inline-block text-sm font-medium text-primary underline underline-offset-4">Return home</Link>
  </section>;
}
