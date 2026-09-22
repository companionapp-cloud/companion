import { findNodeHandle } from 'react-native';
import { setTourMeasurer } from '@companion/app';
import { measureViewInWindow } from '../modules/view-frame';

// The tutorial spotlight measures its elements with UIKit on iOS (modules/view-frame). React
// Native's measureInWindow reads the shadow tree, which puts the note editor's header buttons at
// the window's top-left corner. Elsewhere the module is absent and React Native measures.
export function registerTourMeasurer(): void {
  setTourMeasurer(async (node) => {
    const tag = findNodeHandle(node as Parameters<typeof findNodeHandle>[0]);
    if (tag == null) return undefined;
    return measureViewInWindow(tag);
  });
}
