import { AuthRoute } from './auth-route';
import { AuthForm } from './auth-form';
import { AuthFeedback } from './auth-feedback';
import { useAuthOperation } from './use-auth-operation';
import { useAuth } from './use-auth';
import { useLocation } from 'react-router';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const location = useLocation();
  return <AuthPageContent key={location.key} mode={mode} />;
}

function AuthPageContent({ mode }: { mode: 'login' | 'register' }) {
  const operation = useAuthOperation();
  const { state } = useAuth();
  return <AuthRoute kind={mode === 'register' ? 'registration' : 'guest'}
    feedback={<AuthFeedback feedback={operation.feedback} />}
    pendingLabel={operation.pending ? operation.pending === 'login' ? 'Signing in' : 'Creating your account' : undefined}>
    <AuthForm mode={mode} registrationEnabled={state.registrationEnabled === true}
      remoteFields={operation.feedback && 'error' in operation.feedback && operation.feedback.error.status === 400 ? operation.feedback.error.fields : []}
      submit={(input, canSubmit) => operation.start(mode, canSubmit, input)} />
  </AuthRoute>;
}
