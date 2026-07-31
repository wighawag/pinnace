---
'pinnace': minor
---

Print the publish recipe in the CI summary: `promote-to` / `install-ci --promote-to <id>`.

An `ipfs`-mode staging pipeline ends with two steps no tool can take for you: promote the build to the live site, then move the ENS contenthash. They are easy to get wrong a week later, and the job summary is exactly where someone is already looking, so it now spells them out with the ids and the cid filled in:

> This is a **staging** build: `mandalas.eth` still serves whatever it served before.
> To publish it, in this order:
>
> ```sh
> pnpm pinnace pin --from-site mandalas-staging --as mandalas.eth --endpoint https://ipfs-publisher.example.com
> ```
>
> 2. set the ENS contenthash of `mandalas.eth` to `ipfs://bafy...`

The composite action gains a `promote-to` input and `install-ci` a `--promote-to <id>` flag that bakes it in. It changes no behaviour, only the summary. The order is stated too, because it matters: promoting first means the node is already serving and warming that cid when the record moves, and the previous build stays pinned throughout, so nothing goes dark in between.

Refused up-front: `--promote-to` with `--set-mode ipns` (an ipns deploy re-signs its own name, so there is nothing to promote), and a promotion target equal to the site being deployed.
