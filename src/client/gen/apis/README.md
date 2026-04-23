Where I have generally tried to mirror the structure of the
kubernetes-client/javascript repository, this directory is a deviation.

Because the majority of the code in the gen/ directory is generated from an
OpenAPI spec and ultimately just makes HTTP calls, this directory in
kubernetes-client/javascript does some marshalling and validation and not a lot
else. In _this_ repo, I am going to use this directory to mimic the API of
kubernetes-client/javascript and delegate to my simulated cluster.
