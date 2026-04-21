This directory mimics the src/gen/models directory in the
https://github.com/kubernetes-client/javascript repository, with some changes:

- We use interfaces, not classes.
- We strip comments for brevity.
- We don't wrap fields names in "quotes" unless it is strictly necessary.
- We don't bring over any of the static attributes like mapping or discriminator.
- We don't bring over the attribute type map.

When creating a new file in this directory, make sure it matches a file in the
kubernetes-client/javascript repository. When you're done, make sure the file is
exported from all.ts in this directory as well.
