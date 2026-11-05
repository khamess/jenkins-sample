# jenkins-sample

Minimal Maven (Java 11) sample project built by Jenkins (`Jenkinsfile`: checkout → `mvn clean package` → mail notification).
SonarCloud settings live in `pom.xml`.

- Build & test: `mvn clean package`
- Sources: `src/main/java/fr/orsys/samples/`, tests: `src/test/java/fr/orsys/samples/` (JUnit 3.8.1)

## ECC

This repo uses [ECC](https://github.com/affaan-m/ECC) v2.2.3:

- The `ecc@ecc` plugin is enabled in `.claude/settings.json` (agents, skills, commands, hooks).
  Claude Code prompts to install it when you trust this folder. Commands are namespaced, e.g. `/ecc:plan`.
- ECC's `common` and `java` rules are vendored in `.claude/rules/ecc/`.

Note: the ECC Java rules assume Java 16+ features (records, sealed types) and JUnit 5; this project
targets Java 11 and JUnit 3, so only use those features after upgrading the build.
