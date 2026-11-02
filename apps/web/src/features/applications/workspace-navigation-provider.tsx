import { useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { createPath, UNSAFE_NavigationContext } from 'react-router';
import { createWorkspaceNavigation } from './workspace-navigation';
import { WorkspaceNavigationContext } from './workspace-navigation-context';

export function WorkspaceNavigationProvider({ children }: { children: ReactNode }) {
  const navigation = useContext(UNSAFE_NavigationContext);
  const [guard] = useState(() => createWorkspaceNavigation(window));
  useLayoutEffect(() => guard.install(), [guard]);
  const value = useMemo(() => ({ ...navigation, navigator: { ...navigation.navigator,
    push: (...args: Parameters<typeof navigation.navigator.push>) => guard.navigate(typeof args[0] === 'string' ? args[0] : createPath(args[0]), () => navigation.navigator.push(...args)),
    replace: (...args: Parameters<typeof navigation.navigator.replace>) => guard.navigate(typeof args[0] === 'string' ? args[0] : createPath(args[0]), () => navigation.navigator.replace(...args))
  } }), [navigation, guard]);
  return <WorkspaceNavigationContext value={guard}><UNSAFE_NavigationContext value={value}>{children}</UNSAFE_NavigationContext></WorkspaceNavigationContext>;
}
