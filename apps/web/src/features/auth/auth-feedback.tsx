import { useEffect, useState } from 'react';
import type { OperationFeedback } from './use-auth-operation';

export function AuthFeedback({ feedback }: { feedback: OperationFeedback }) {
  const [time, setTime] = useState(Date.now);
  const deadline = feedback && 'error' in feedback ? feedback.error.retryAt : null;
  useEffect(() => {
    if (deadline === null) return;
    const timer = setInterval(() => { const now = Date.now(); setTime(now); if (now >= deadline) clearInterval(timer); }, 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  if (!feedback) return null;
  if ('message' in feedback) return <p role="status" className="border-l-2 border-primary pl-4 text-sm leading-6">{feedback.message}</p>;
  const { error } = feedback;
  let message = 'Your session needs to be checked before another attempt. No request will be retried automatically.';
  if (error.status === 429 || error.kind === 'cooldown') message = 'Too many attempts. Wait before trying again; no request will be retried automatically.';
  else if (error.kind === 'network' || error.kind === 'protocol' || error.status >= 500) message = 'We could not confirm the request outcome. Check your session before deciding what to do next. Do not assume it failed.';
  else if (error.code === 'INVALID_CREDENTIALS') message = 'The email or password was not recognized. Check both and try again.';
  else if (error.status === 404) message = 'Account creation is not available here. Sign in to an existing account.';
  else if (error.status === 400 || error.kind === 'validation') message = 'The request was not accepted. Review your email and password before trying again.';
  else if (error.code === 'ACCOUNT_UNAVAILABLE') message = 'An account could not be created with those details. Try signing in to an existing account.';
  else if (error.status === 403) message = 'The security check was not accepted. Check your session before trying again.';
  return <div className="space-y-2 border-l-2 border-primary pl-4 text-sm leading-6">
    <p role="alert">{message}</p>
    {deadline !== null && <p className="text-muted-foreground">{time < deadline
      ? `Try again in ${Math.max(0, Math.ceil((deadline - time) / 1000))} seconds.` : 'You can now explicitly check your session or try again when the form is available.'}</p>}
  </div>;
}
