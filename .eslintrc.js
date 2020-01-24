module.exports = {
  extends: ['standard'],
  plugins: [
    'standard',
    'prettier'
  ],
  rules: {
    semi: ['error', 'always'],
    'no-extra-semi': 'error',
    'space-before-function-paren': 'off',
    'keyword-spacing': ['error', { before: true, after: true }],
    'no-unused-vars': 'off',
    'import/export': 'error'
  }
};
