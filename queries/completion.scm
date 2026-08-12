; Scope nodes: function definitions and lambdas create a new scope.
; The global scope covers the whole file implicitly.

[
  (lambda)
  (function)
  (atomic_function)
] @completion.scope

(parameters
  (identifier) @completion.parameter)

(qualified_parameters
  (identifier) @completion.parameter)

(qualified_parameters
  (qualified_identifier
    (identifier) @completion.parameter))

(lambda_parameters
  (identifier) @completion.parameter)

(locals
  (identifier) @completion.var)

(assignment_statement
  left: (identifier) @completion.var)

(for_statement
  identifier: (identifier) @completion.var)

(assignment_statement
  left: (identifier) @completion.function
  right: [
    (lambda)
    (function)
    (atomic_function)
  ])
