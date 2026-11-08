export function Copy({ count, done, name }) {
  return (
    <div title="Card title" className="card" aria-hidden="true">
      <img src="/brand-mark.svg" alt="Windmill" />
      <button aria-label={done ? 'Saved' : 'Save'} type="button">Save changes</button>
      <p>{count} · {`${count} sets`}</p>
      <p>{done && 'All done'}</p>
      <p>{'Hello, ' + name}</p>
      <input placeholder="Search" data-kind="label" />
      <span>—</span>
      <span>{name}</span>
    </div>
  );
}
