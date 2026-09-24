# Windmill Gym for Android 0.9.3

Coach answers now arrive smoothly and read the way the model wrote them.

- Streamed text grows word by word instead of dropping in a few lines at a time, and the view
  keeps the newest words in sight without chasing them. Scrolling back to reread pauses following;
  Jump to latest resumes it.
- Answers render their formatting: bold and italic phrases, headings, bullet and numbered lists,
  inline and fenced code. Markers no longer show as raw asterisks or dashes, including while an
  answer is still arriving.
- Tapping a message no longer flashes a ripple. Long press, tap or the accessibility Copy action
  still copies either message; an answer copies as plain text.
- Returning to Coach while an answer is still streaming shows what has arrived and continues from
  there.

## Installation

Install this APK over 0.9.2 to keep local routines and training. The retained release signing
identity supports Android's normal in-place update.

Historical APKs through 0.7.1 used different certificates and cannot update in place. Uninstalling
removes records saved only on that phone; preserve those records before changing the installation.
Signing in alone does not transfer anonymous records.
