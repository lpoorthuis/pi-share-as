# pi-share-as

Pi package that adds a global `/share-as` command.

## What it does

`/share-as <name>`:

- exports the current Pi session as `session.html`
- creates a **private GitHub gist**
- uses `<name>` as the gist description
- prints both:
  - the gist URL
  - the Pi viewer URL in the required format: `https://pi.dev/session/#<gist_id>`

## Requirements

- [`gh`](https://cli.github.com/) installed
- `gh auth login` completed

## Install

From anywhere:

```bash
pi install /home/lpoorth/workspace/lpoorth/pi-share-as
```

Or from this directory:

```bash
pi install .
```

## Use

```text
/share-as My custom gist title
```

## Notes

- The HTML file inside the gist must be named `session.html` for `pi.dev/session/#<gist_id>` to work.
- The command only customizes the **gist description**, not the uploaded filename.
