# Design principles

The activity is the interface. Give the visitor's attention and available space to participation. Use minimal branding, neutral colours, thin borders, small controls, and visible keyboard focus. The character can feel retro and familiar without imitating a dashboard or adding decorative chrome.

The shared `SpaceLayout` provides the document shell, typography, design tokens, focus treatment, safe-area positioning, optional utility controls, and the GlobalMenu. It scrolls as a normal document by default. A space that needs to occupy the entire viewport opts into `layout="viewport"`; that mode is used by The Wall and must not become a platform-wide restriction. A distinct shell can import the standalone GlobalMenu component without copying it.

Let each space choose its interaction, content structure, and density. Do not require a large title, description, onboarding, fixed canvas, panel grid, or shared content component. Reuse a component only when it already solves a real need across spaces.

Keep navigation compact and understated. The GlobalMenu reads active entries from the shared registry and uses native disclosure behavior for keyboard and touch. Maintain useful focus indicators, accessible names and status, adequate hit targets, and safe-area spacing. Respect reduced motion and avoid unnecessary animation.

No promotional surfaces, tracking, gamification, popularity rankings, advertising, or conventional account UI. Technical limits may protect the service from flooding and resource exhaustion; they do not define what people may say or create.
