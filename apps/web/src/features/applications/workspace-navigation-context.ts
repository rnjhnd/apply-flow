import { createContext } from 'react';
import type { createWorkspaceNavigation } from './workspace-navigation';

export const WorkspaceNavigationContext = createContext<ReturnType<typeof createWorkspaceNavigation> | null>(null);
