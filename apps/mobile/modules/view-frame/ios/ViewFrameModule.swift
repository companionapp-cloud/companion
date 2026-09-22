import ExpoModulesCore
import UIKit

// Where a React view really is in its window, asked of UIKit. React Native's measureInWindow adds
// up origins in the shadow tree instead, which goes wrong for views UIKit places itself: an item
// in a native stack header measures at the window's top-left corner. The tutorial spotlight
// (packages/app/src/onboarding) measures with this.
public class ViewFrameModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ViewFrame")

    // [x, y, width, height] in window points, or nil when the view is gone or off the window (a
    // screen covered by the one pushed over it).
    AsyncFunction("measureInWindow") { (tag: Int) -> [Double]? in
      guard let view = self.appContext?.findView(withTag: tag, ofType: UIView.self), view.window != nil else {
        return nil
      }
      let rect = view.convert(view.bounds, to: nil)
      return [rect.origin.x, rect.origin.y, rect.width, rect.height]
    }.runOnQueue(.main)
  }
}
