## Project

Mapping tables is a module that will be included by other hosts

## Architecture & Design
Optimize for the reader, not the writer. Code is read far more than it's written — favor the obvious over the clever
Make structure explicit. A newcomer should infer where things live from folder and file names alone; the directory tree should read like a description of the system
Push complexity to the edges, keep the core small. Business logic stays pure and dependency-light; messy details (I/O, vendors, frameworks) live at the boundary
try to place vast amount of logic into domain layer, rather than other layers. try to shape the code so you have Action that loads data using repositories and then passes it into domain layer. Domain layer does the calc and returns an object for persistence via Batch. If you need to load additional data inside the domain logic - split it into 2 phases, 1st phase load data from repo and call domain layer, then using the result load new data and call domain layer again
Keep dependency graph between modules clear, not just domain in the center, but like that entities can't depend on helper objects.
think about the shape, there are a lot of ways to write working code - real professionalism is defined by the shape
Try to make each module and each class excellent from the way it looks and the way it naturally fits the system. Aim for readable code over performant or conciese. Performance can be optimized later
We are here for the beautiful design, we are mission oriented and it's our number 1 priority. Features is 2nd priority.
Don't be afraid to spend more time thinking and refactoring system to fit the solution naturally. Beautify more than in the scope so the overall it looks better
Behave like elite level software engineer
Structure is the most important part of any system, structure decides whether the system is buggy and hard to evolve or is quite explicit, easy to read, understand and modify. Well structured code simply does not allow bugs sometimes, because structure makes them impossible. Structure the app in a right way 
Prefer composition over inheritance. Reserve inheritance for genuine interface/template relationships
Inject collaborators through constructors/factories. Make dependencies explicit and swappable — so tests substitute fakes for free, with no patching
Express a functions as an explicit, ordered, fail-fast pipeline of steps that reads top-to-bottom easily like a plain english
When several implementations share a fixed sequence of steps, put the sequence as a concrete method on the shared abstract base, and let each implementation override only the piece that actually varies. Don't let sibling classes each re-implement the same skeleton.
Audit for single-call-site indirection during refactors: if a function, method, or file has exactly one caller left, inline it into the caller. A separate file needs more than one consumer — or a name that genuinely earns its place — to justify existing.
For a small, self-contained feature area (one file format, one integration), prefer grouping all of its code — including the parsing/serialization boundary — under one feature-named package, rather than scattering it across domain/ vs infra-style layers. Reserve the layered split for logic that's genuinely reused by more than one feature.

## Conventions

use constructors on entities instead of helper functions
When working with API endpoints, for models that come in name them with Request suffix, for outgoing name with Response suffix.
Dont use from collections.abc import Mapping or from typing import Mapping for type notations, use dict.
Dont use assert_never, raise ValueError instead.
Dont write docstrings or multiline commentaries.

If you have an abstraction with different implementations. put abstraction and all required data structures in a single file, but all implementations should be contained in their own files. Unless implementations are small and can be placed in a single file
Don't make a lot of small files/classes. there should be a very good reason to have class lesser than 40 lines of code
Give each module one reason to exist. Group small related classes by kind in one predictable file (all DTOs together, all exceptions together) rather than scattering them

You shouldn't write private (starting with underscore) helper functions unless you have a great reason why. The logic should be either inlined or folded into the solution naturally

## Testing

Layout of the test folder should mirror project layout.
In tests prefer full assertions, rather than partial assertions like

## Code Style

in if-else statements do early returns rather then assigning variables

## Workflow & Tooling

You have poetry runtime in this project, so use poetry directly or .venv/bin/python
Stage your changes when you're done with the phase (or iteration)
After each phase note observarions you had that can enhance overall structure of the program or/and performance
Keep a running log of such observations in .md file and execute ones you find most important

If you seek for an advice, you can spin up an agent that has no access to the code, so he can give you unbiased advice on architecture or ideas
