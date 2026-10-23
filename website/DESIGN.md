# Website direction

TolkTak is a self-hosted communication server for personal use, communities and
organisations. The homepage introduces chats, calls and screen sharing, shows
the interface and explains self-hosting. The app is the main visual.

- Paper `#f5f7fb`, white `#ffffff`, ink `#192641`, secondary `#5b687d`,
  orange `#e87146`, pale blue `#e8eef7`.
- Self-hosted Golos Text, 400–800. Large, compact headings; readable body text.
- Quiet header; left-aligned introduction beside a real app screenshot;
  full-width screenshot viewer; separate download and documentation pages.
- Reserve orange for the logo and primary action. No gradients outside the
  existing logo, decorative badges, invented testimonials or usage statistics.
- The author supplies the meaning and reviews Russian copy before it is added.
  Agreed text lives in `content/home.mjs`; English follows the same meaning.
- Describe capabilities without addressing the reader with instructions. Keep
  detailed feature lists and setup instructions in the documentation.
- Keep the audience broad. The author story, comparisons with Discord or
  TeamSpeak, bot API and AI plans do not belong on this homepage.
- Omit introductions that repeat the page title or nearby links. The self-hosting
  overview needs one sentence and its three guide links.
- App setup should cover the build and sign-in. Skip code-signing notices and
  detailed operating-system installation steps in these introductory pages.

The initial idea of a floating call notification was dropped: it would look like
an invented product feature. The existing screenshots carry that job instead.

Documentation is generated from Markdown, readable without JavaScript, with
section links, a table of contents and previous/next navigation. Search runs
locally in the browser. Downloads link to verified release assets, with a checked
in release snapshot so the buttons also work without a GitHub API request.
