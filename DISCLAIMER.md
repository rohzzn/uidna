# Disclaimer

UI DNA is an instrument for understanding how a user interface is built. It is
intended for interfaces you are authorized to analyze: your own products,
interfaces you have written permission to study, fixtures, and public pages
whose terms of use permit automated access.

## What UI DNA will not do

- It never bypasses authentication, CAPTCHAs, bot detection, rate limits or
  any other access control. Attaching to your own browser over the Chrome
  DevTools Protocol lets you analyze a session you already opened; UI DNA
  does not log in for you and never stores credentials.
- It honors `robots.txt` for pages it loads itself and applies a per-scan
  budget of time, pages and resources.
- It does not redistribute third-party assets. Fonts, images and SVGs that
  are not marked as authorized in the UI DNA document are replaced with
  labeled placeholders in generated projects.
- It does not call any language model and sends nothing it captured off your
  machine. Everything it captures is written under `./.uidna/` in your
  project. The only outbound traffic besides loading the page you point it at
  is `npm install` in a generated project, which fetches packages from the
  npm registry (pass `install: false` to skip it).

## Your responsibilities

- Confirm that you may analyze the interface before you scan it. The safe
  interaction policy avoids actions with side effects, but it operates on
  the live page you point it at.
- Treat the captured material as what it is: a copy of someone else's work
  product when the target is not yours. Reconstructions are for learning,
  interoperability testing and building your own implementation, not for
  republishing the original.
- Review generated code before shipping it. The generator is a deterministic
  baseline; correctness, naming and licensing of the result are yours.

UI DNA is provided "as is" under the MIT license, without warranty of any
kind. The authors are not responsible for how it is used.
