# Built by real_samples_test.go: a privileged step is refused (#215).
FROM busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec
RUN --security=insecure echo "reached" "the host"
USER nobody
