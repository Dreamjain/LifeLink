import type { ReactElement } from 'react';
import { render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

/**
 * Safe-area insets are normally measured on a real device. Supplying them up front keeps
 * `SafeAreaProvider` from rendering nothing until a layout pass that never happens under Jest.
 */
const TEST_METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

export const renderWithProviders = (ui: ReactElement): ReturnType<typeof render> =>
  render(<SafeAreaProvider initialMetrics={TEST_METRICS}>{ui}</SafeAreaProvider>);
