# Photographs

Drop a photograph in here named after the slot it belongs to, with a `.txt`
file beside it holding its description, and it goes onto the site on the next
deploy.

```
assets/photographs/statement-portrait.jpg
assets/photographs/statement-portrait.txt
```

The slot names are in `src/features/images/slots.ts`, and the admin page at
`/admin/images` lists every one of them with what to shoot.

The `.txt` file is what someone using a screen reader gets instead of the
picture, so it is required. One sentence: *"Quiana, seated, looking at the
camera, against a plain wall."*

Location data and orientation flags are stripped on the way in, and the file is
resized and converted — send the biggest version you have.

Anything uploaded through the admin wins. A file here will not overwrite a
photograph a person chose on the site.
