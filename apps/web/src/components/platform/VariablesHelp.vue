<template>
  <div class="help" data-testid="variables-help">
    <p>
      Variables are named values that belong to the Test. Define a value once here and reuse it in
      any Step, instead of repeating it in every Step.
    </p>

    <h3>What you enter</h3>
    <p>A JSON object. Invalid JSON is flagged and the Test cannot be saved until it is fixed.</p>
    <pre class="help-code"><code v-pre>{
  "orderId": "ORD-42",
  "apiPath": "/orders/{{testData.order.id}}"
}</code></pre>

    <h3>Using a variable in a Step</h3>
    <p>
      Put <code v-pre>{{ variables.orderId }}</code> in any Step parameter. It is replaced with the
      value when the Run reaches that Step.
    </p>

    <h3>What a value can contain</h3>
    <p>A literal, or an expression that reads from:</p>
    <ul>
      <li>
        the selected Test Data: <code v-pre>{{testData.…}}</code>
      </li>
      <li>
        the Environment's non-secret values: <code v-pre>{{environment.…}}</code>
      </li>
      <li>
        other variables: <code v-pre>{{variables.…}}</code>
      </li>
    </ul>
    <p>
      The order you declare them in does not matter: variables are sorted by their dependencies, and
      a circular reference is rejected.
    </p>

    <h3>When they are resolved</h3>
    <p>
      Once, at the start of a Run, before the first Step. A variable cannot use Step outputs (<code
        v-pre
        >{{steps.…}}</code
      >); only Steps themselves can.
    </p>

    <h3>Overriding for one Run</h3>
    <p>
      When you launch a Run, the launch page offers an optional field for each declared variable. A
      value there replaces the variable for that Run only, and the Test itself is not changed. Only
      declared variables can be overridden, and overrides must not contain secrets.
    </p>

    <h3>Secrets</h3>
    <p>
      Do not put credentials in variables. Values that look like connection strings or keys are
      refused when the Test is saved. Use the Environment's secret references instead.
    </p>
  </div>
</template>

<style scoped>
.help {
  font-size: var(--td-text-sm);
}
.help p,
.help ul {
  margin: 0 0 var(--td-space-3);
}
.help ul {
  padding-left: var(--td-space-5);
}
.help h3 {
  margin: var(--td-space-5) 0 var(--td-space-1);
  font-size: var(--td-text-sm);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--td-accent-text);
}
.help-code {
  font-size: var(--td-text-xs);
}
</style>
