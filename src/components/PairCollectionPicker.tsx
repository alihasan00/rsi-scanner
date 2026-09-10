import { Segmented } from 'antd'
import { StarOutlined } from '@ant-design/icons'

interface Props {
  starredOnly: boolean
  starredCount: number
  onChange: (starredOnly: boolean) => void
}

export function PairCollectionPicker({ starredOnly, starredCount, onChange }: Props) {
  return <Segmented<'all' | 'starred'>
    className="screener__pair-collection"
    aria-label="Pair collection"
    value={starredOnly ? 'starred' : 'all'}
    onChange={(value) => onChange(value === 'starred')}
    options={[
      { value: 'all', label: 'All pairs' },
      { value: 'starred', icon: <StarOutlined aria-hidden="true" />, label: <>Starred <span className="screener__collection-count">{starredCount}</span></> },
    ]}
  />
}
